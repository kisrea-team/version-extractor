#!/usr/bin/env python3
"""
Trafilatura 正文清洗入口。

用法：python scripts/trafilatura_clean.py <html_file> [--format markdown] [--precision]

从定位到的版本区块 HTML 中提取干净正文（去导航/版权/图片/HTML残片），
输出 Markdown 或纯文本。供 TS 侧通过子进程调用。
"""
import argparse
import sys

# Windows 控制台默认 GBK，输出 markdown 含非 GBK 字符会崩溃；强制 UTF-8
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('input', help='HTML 文件路径，或 - 读 stdin')
    parser.add_argument('--format', default='markdown', choices=['markdown', 'txt'])
    parser.add_argument('--precision', action='store_true', help='偏向精确（更少噪音但可能截断）')
    parser.add_argument('--recall', action='store_true', help='偏向召回（更完整但可能含导航）')
    args = parser.parse_args()

    if args.input == '-':
        html = sys.stdin.read()
    else:
        with open(args.input, encoding='utf-8', errors='ignore') as f:
            html = f.read()

    import trafilatura
    text = trafilatura.extract(
        html,
        output_format=args.format,
        include_comments=False,
        include_links=False,
        favor_precision=args.precision,
        favor_recall=args.recall,
    )
    if text:
        sys.stdout.write(text)
    else:
        sys.exit(2)  # 无正文，调用方降级


if __name__ == '__main__':
    main()
