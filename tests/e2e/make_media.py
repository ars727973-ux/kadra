"""Генерация тестовых медиафайлов для e2e (нужен ffmpeg в PATH).

python tests/e2e/make_media.py /tmp/kadra-media
"""
import subprocess
import sys
from pathlib import Path

out = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/kadra-media")
out.mkdir(parents=True, exist_ok=True)


def ff(*args):
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", *args], check=True)


# 1080p30 H.264 + AAC, 4 с
ff("-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30:duration=4", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=4",
   "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-shortest", str(out / "clip1.mp4"))
# 720p25 VP9 + Opus (WebM), 3 с
ff("-f", "lavfi", "-i", "smptebars=size=1280x720:rate=25:duration=3", "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000:duration=3",
   "-c:v", "libvpx-vp9", "-b:v", "1M", "-deadline", "realtime", "-cpu-used", "8", "-c:a", "libopus", "-b:a", "96k", "-shortest", str(out / "clip2.webm"))
# 720p30 H.264 + AAC в контейнере QuickTime (MOV), 3 с
ff("-f", "lavfi", "-i", "mandelbrot=size=1280x720:rate=30", "-t", "3", "-f", "lavfi", "-i", "sine=frequency=330:duration=3",
   "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-f", "mov", str(out / "clip3.mov"))
# изображение 1920×1080
try:
    ff("-f", "lavfi", "-i", "color=c=0x3366aa:size=1920x1080,drawtext=text='KADRA':fontsize=200:fontcolor=white:x=(w-tw)/2:y=(h-th)/2", "-frames:v", "1", str(out / "title.png"))
except subprocess.CalledProcessError:  # ffmpeg без drawtext
    ff("-f", "lavfi", "-i", "color=c=0x3366aa:size=1920x1080", "-frames:v", "1", str(out / "title.png"))
# MP3, 44.1 кГц, 5 с
ff("-f", "lavfi", "-i", "sine=frequency=220:sample_rate=44100:duration=5", "-c:a", "libmp3lame", "-b:a", "128k", str(out / "music.mp3"))
print("Готово:", *sorted(p.name for p in out.iterdir()))
