import json
import os
import subprocess

def run_command(cmd_list, desc=""):
    print(desc)
    print(f"执行命令: {' '.join(cmd_list)}")
    result = subprocess.run(cmd_list)
    if result.returncode != 0:
        print(f"❌ 失败: {desc}")
    return result.returncode == 0

def create_rally_clips():
    json_path = 'rallies_test.json'
    video_path = r'prediction\clip_720p.mp4'
    output_merged = r'prediction\rallies_merged.mp4'

    if not os.path.exists(json_path):
        print(f"❌ 找不到 JSON: {json_path}")
        return
    if not os.path.exists(video_path):
        print(f"❌ 找不到视频: {video_path}")
        return

    with open(json_path, 'r', encoding='utf-8') as f:
        rallies = json.load(f)

    print(f"共发现 {len(rallies)} 个回合，开始处理...")
    
    clip_files = []
    
    # 1. 剪切片段
    for idx, rally in enumerate(rallies):
        start = rally['start']
        duration = rally['duration']
        clip_name = f'prediction/temp_rally_{idx+1}.mp4'
        clip_files.append(clip_name)

        cmd = [
            'ffmpeg', '-y', 
            '-ss', str(start), 
            '-t', str(duration), 
            '-i', video_path, 
            '-c', 'copy',  # 无损直接拷贝（速度极快）
            clip_name
        ]
        
        success = run_command(cmd, desc=f"剪切第 {idx+1} 个片段 ({start} 持续 {duration}s)")
        if not success:
            print("❌ 提取出错，退出。")
            return

    # 2. 生成 concat list
    concat_list_path = 'prediction/concat_list.txt'
    with open(concat_list_path, 'w', encoding='utf-8') as f:
        for cf in clip_files:
            # ffmpeg concat 的文件路径需要相对路径，或者处理好转义
            # prediction 文件夹内部相对路径
            filename = os.path.basename(cf)
            f.write(f"file '{filename}'\n")

    # 3. 合并文件
    merge_cmd = [
        'ffmpeg', '-y', 
        '-f', 'concat', 
        '-safe', '0', 
        '-i', concat_list_path, 
        '-c', 'copy', 
        output_merged
    ]
    succ = run_command(merge_cmd, desc="合并所有回合片段")
    
    # 清理临时文件
    if os.path.exists(concat_list_path):
        os.remove(concat_list_path)
    for cf in clip_files:
        if os.path.exists(cf):
            os.remove(cf)

    if succ:
        print(f"\n✅ 成功！合并后的视频存放于: {output_merged}")
        print("您现在可以查看这个视频以验证推理准确性。")

if __name__ == "__main__":
    create_rally_clips()
