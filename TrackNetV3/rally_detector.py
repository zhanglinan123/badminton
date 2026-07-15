"""
rally_detector.py
-----------------
输入: TrackNetV3 predict.py 输出的球坐标 CSV 文件
输出: 回合时间戳列表（JSON），每条包含 start/end/duration

回合检测规则：
  开始: 球速矢量幅值突升（触球信号）
  结束: 球长时间不可见（落地/出界）或速度持续极低（静止）
  过滤: 回合时长 < min_duration(默认4s) 的丢弃

用法:
  python rally_detector.py --csv prediction/video.csv --fps 30 --min_duration 4 --output rallies.json

CSV 格式（TrackNetV3 标准输出）:
  Frame,Visibility,X,Y
  0,1,320,240
  ...
"""

import argparse
import json
import math
import os
import sys

import pandas as pd
import numpy as np


# ──────────────────────────────────────────────
# 参数与阈值（可通过命令行覆盖）
# ──────────────────────────────────────────────
SPEED_HIT_THRESHOLD    = 15.0   # 像素/帧：超过此速度视为触球（回合开始候选）
SPEED_STOP_THRESHOLD   = 3.0    # 像素/帧：低于此速度视为静止
INVISIBLE_END_FRAMES   = 30     # 连续不可见帧数超过此值 → 强制结束回合
STATIC_END_FRAMES      = 20     # 连续静止帧数超过此值 → 视为球落地，结束回合
DEBOUNCE_FRAMES        = 15     # 两次触球信号间距小于此帧数时合并（去抖）


def frames_to_time(frame_idx: int, fps: float) -> str:
    total_sec = frame_idx / fps
    h = int(total_sec // 3600)
    m = int((total_sec % 3600) // 60)
    s = int(total_sec % 60)
    return f"{h:02d}:{m:02d}:{s:02d}"


def detect_rallies(csv_path: str, fps: float, min_duration: float) -> list:
    df = pd.read_csv(csv_path)

    df.columns = [c.strip().lower() for c in df.columns]
    
    # 【0】剔除瞬移脏数据 (Tracker Teleportation) 
    # 原数据中存在大量相邻帧动辄跳跃 100 多像素的假检测(可能把远处的拍子、鞋等其他白色物体当做了球)
    # 羽毛球即便极快，1帧(33ms)内跳跃也很少超过 80 像素 (720p下)。
    df['dist_to_prev'] = np.sqrt(df['x'].diff()**2 + df['y'].diff()**2)
    # 只要出现了空间瞬间瞬移，我们认为这一帧是虚假的跟丢，强行置为不可见
    df.loc[df['dist_to_prev'] > 80, 'visibility'] = 0

    df['x_smooth'] = df['x'].where(df['visibility'] == 1).fillna(method='ffill', limit=3).fillna(method='bfill', limit=3)
    df['y_smooth'] = df['y'].where(df['visibility'] == 1).fillna(method='ffill', limit=3).fillna(method='bfill', limit=3)
    df['dx'] = df['x_smooth'].diff()
    df['dy'] = df['y_smooth'].diff()
    df['speed'] = np.sqrt(df['dx']**2 + df['dy']**2).fillna(0)
    
    ACT_SPEED_THRESHOLD = 8.0 # 稍微提高速度阈值
    df['is_valid_flying'] = (
        (df['visibility'] == 1) & 
        (df['speed'] > ACT_SPEED_THRESHOLD) & 
        (df['y'] < 500)  # 500或以上通常是在地板了(基于最高600多)
    ).astype(int)

    dx_sm = df['dx'].rolling(3, center=True).mean()
    dy_sm = df['dy'].rolling(3, center=True).mean()
    
    delay = 6
    dot_product = dx_sm * dx_sm.shift(delay) + dy_sm * dy_sm.shift(delay)
    
    # 一个极端的负值意味着巨大的折返
    df['is_hit'] = ((dot_product < -50) & (df['speed'] > 15)).astype(int)

    window_size = int(fps * 2.0) 
    df['flying_ratio'] = df['is_valid_flying'].rolling(window=window_size, min_periods=1).mean().fillna(0)
    df['strikes_in_recent'] = df['is_hit'].rolling(window=int(fps * 4.0), min_periods=1).sum().fillna(0)

    rallies = []
    in_rally = False
    start_frame = -1
    last_hit_frame = -1
    
    # 我们遍历每一帧
    for idx, row in df.iterrows():
        # 如果这是确定的击球点（折返点）
        if row['is_hit'] == 1:
            if not in_rally:
                # 开启新回合
                in_rally = True
                start_frame = idx
                last_hit_frame = idx
            else:
                # 仍在回合中，刷新最后击球时间
                last_hit_frame = idx
        
        # 实时判定回合是否结束了
        if in_rally:
            passed_since_last_hit = idx - last_hit_frame
            
            # 【强制切分条件】
            # 如果自上一次有效击球(或发球) 已经过去了超过 3.5 秒 (约105帧)，
            # 那现在的所谓“走走停停/球在空中抛”都只是垃圾时间。回合实际上在最后一次击球时就已经结束。
            # 或者，如果在空中飞行的比例低于 10% (地上乱滚)，也判定为死球。
            if passed_since_last_hit > int(fps * 3.5) or (idx - start_frame > window_size and row['flying_ratio'] < 0.10):
                # 走到这里，无论如何，回合都已经断掉了。
                # 这个回合的实际持续时间只从开头的发球算到最后一次接发球的落地期间。
                # 为了包含球在空中下落的过程，我们可以在 last_hit_frame 后加上一定的尾巴（例如 1.5 秒）
                
                computed_end_frame = min(last_hit_frame + int(fps * 1.5), idx)
                duration_sec = (computed_end_frame - start_frame) / fps
                
                if duration_sec >= min_duration:
                    rallies.append({
                        "start_frame": int(start_frame),
                        "end_frame":   int(computed_end_frame),
                        "start":       frames_to_time(start_frame, fps),
                        "end":         frames_to_time(computed_end_frame, fps),
                        "duration":    round(duration_sec, 1)
                    })
                in_rally = False
                start_frame = -1
                last_hit_frame = -1

    # 文件结尾收口
    if in_rally:
        computed_end_frame = min(last_hit_frame + int(fps * 1.5), len(df) - 1)
        duration_sec = (computed_end_frame - start_frame) / fps
        if duration_sec >= min_duration:
            rallies.append({
                "start_frame": int(start_frame),
                "end_frame":   int(computed_end_frame),
                "start":       frames_to_time(start_frame, fps),
                "end":         frames_to_time(computed_end_frame, fps),
                "duration":    round(duration_sec, 1)
            })

    print(f"[rally_detector] 过滤后有效回合数: {len(rallies)}")
    return rallies


def main():
    global SPEED_HIT_THRESHOLD, INVISIBLE_END_FRAMES, STATIC_END_FRAMES
    parser = argparse.ArgumentParser(description="TrackNetV3 球坐标CSV → 回合时间戳")
    parser.add_argument("--csv",          required=True,  help="TrackNetV3 输出的 CSV 文件路径")
    parser.add_argument("--fps",          type=float, default=30.0)
    parser.add_argument("--min_duration", type=float, default=4.0)
    parser.add_argument("--output",       default="rallies.json")
    parser.add_argument("--speed_hit",     type=float, default=SPEED_HIT_THRESHOLD)
    parser.add_argument("--invisible_end", type=int,   default=INVISIBLE_END_FRAMES)
    parser.add_argument("--static_end",    type=int,   default=STATIC_END_FRAMES)
    args = parser.parse_args()

    SPEED_HIT_THRESHOLD  = args.speed_hit
    INVISIBLE_END_FRAMES = args.invisible_end
    STATIC_END_FRAMES    = args.static_end

    if not os.path.exists(args.csv):
        print(f"[ERROR] CSV 文件不存在: {args.csv}")
        sys.exit(1)

    print(f"[rally_detector] 读取: {args.csv}")
    rallies = detect_rallies(args.csv, args.fps, args.min_duration)

    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(rallies, f, ensure_ascii=False, indent=2)

    print(f"\n[rally_detector] 结果已写入: {args.output}")
    print(f"[rally_detector] 共 {len(rallies)} 个有效回合:\n")
    for idx, r in enumerate(rallies, 1):
        print(f"  {idx:3d}. {r['start']} -> {r['end']}  ({r['duration']}s)")


if __name__ == "__main__":
    main()
