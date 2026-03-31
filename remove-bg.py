"""
Remove background from product images.
Usage: python3 remove-bg.py <input_url_or_path> <output_path>
"""
import sys
import os
from pathlib import Path

def remove_bg(input_path, output_path):
    from rembg import remove
    from PIL import Image
    import io

    # Handle URL or file path
    if input_path.startswith("http"):
        import urllib.request
        req = urllib.request.Request(input_path, headers={"User-Agent": "Mozilla/5.0"})
        data = urllib.request.urlopen(req).read()
    else:
        data = Path(input_path).read_bytes()

    result = remove(data)

    # Save as PNG (preserves transparency)
    img = Image.open(io.BytesIO(result))
    img.save(output_path, "PNG")
    print(f"OK {output_path} ({img.size[0]}x{img.size[1]})")

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python3 remove-bg.py <input_url_or_path> <output_path>")
        sys.exit(1)
    remove_bg(sys.argv[1], sys.argv[2])
