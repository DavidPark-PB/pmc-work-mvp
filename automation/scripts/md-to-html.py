"""
MD → 단일 HTML 변환 (이미지 base64 인라인)
"""
import re
import os
import base64
import mimetypes

def img_to_base64(img_path):
    mime, _ = mimetypes.guess_type(img_path)
    if not mime:
        mime = "image/png"
    with open(img_path, "rb") as f:
        data = base64.b64encode(f.read()).decode()
    return f"data:{mime};base64,{data}"

def md_to_html(md_text, base_dir, title):
    lines = md_text.split('\n')
    html_parts = []

    i = 0
    in_table = False
    table_rows = []

    def flush_table():
        nonlocal in_table, table_rows
        if not table_rows:
            return ""
        # 구분선 제거
        data_rows = [r for r in table_rows if not re.match(r'^[\|\s\-:]+$', r)]
        if not data_rows:
            table_rows = []
            in_table = False
            return ""
        out = '<div class="table-wrap"><table>\n'
        for ri, row in enumerate(data_rows):
            cells = [c.strip() for c in row.strip('|').split('|')]
            tag = "th" if ri == 0 else "td"
            out += "<tr>"
            for cell in cells:
                out += f"<{tag}>{inline(cell)}</{tag}>"
            out += "</tr>\n"
        out += "</table></div>\n"
        table_rows = []
        in_table = False
        return out

    def inline(text):
        # bold
        text = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', text)
        # inline code
        text = re.sub(r'`([^`]+)`', r'<code>\1</code>', text)
        # links
        text = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', r'<a href="\2">\1</a>', text)
        return text

    while i < len(lines):
        line = lines[i]
        stripped = line.strip()

        # 테이블 수집 중이면
        if in_table:
            if '|' in stripped:
                table_rows.append(stripped)
                i += 1
                continue
            else:
                html_parts.append(flush_table())
                in_table = False
                # 현재 줄 다시 처리
                continue

        # 빈 줄
        if not stripped:
            i += 1
            continue

        # 수평선
        if stripped in ('---', '***', '___'):
            html_parts.append('<hr>\n')
            i += 1
            continue

        # 헤딩
        m = re.match(r'^(#{1,4})\s+(.+)$', stripped)
        if m:
            level = len(m.group(1))
            text = inline(m.group(2))
            html_parts.append(f'<h{level}>{text}</h{level}>\n')
            i += 1
            continue

        # 이미지
        m = re.match(r'^!\[([^\]]*)\]\(([^)]+)\)', stripped)
        if m:
            alt = m.group(1)
            src = m.group(2)
            img_path = os.path.join(base_dir, src)
            if os.path.exists(img_path):
                data_uri = img_to_base64(img_path)
                html_parts.append(f'<figure><img src="{data_uri}" alt="{alt}"><figcaption>{alt}</figcaption></figure>\n')
            else:
                html_parts.append(f'<p class="missing">[이미지 없음: {src}]</p>\n')
            i += 1
            continue

        # 블록인용
        if stripped.startswith('>'):
            quote_lines = []
            while i < len(lines) and lines[i].strip().startswith('>'):
                quote_lines.append(lines[i].strip().lstrip('>').strip())
                i += 1
            text = inline(' '.join(quote_lines))
            html_parts.append(f'<blockquote>{text}</blockquote>\n')
            continue

        # 테이블 시작
        if '|' in stripped:
            in_table = True
            table_rows = [stripped]
            i += 1
            continue

        # 불릿 리스트
        m = re.match(r'^[-*]\s+(.+)$', stripped)
        if m:
            items = []
            while i < len(lines) and re.match(r'^[-*]\s+', lines[i].strip()):
                items.append(inline(re.match(r'^[-*]\s+(.+)$', lines[i].strip()).group(1)))
                i += 1
            html_parts.append('<ul>\n')
            for item in items:
                html_parts.append(f'  <li>{item}</li>\n')
            html_parts.append('</ul>\n')
            continue

        # 번호 리스트
        m = re.match(r'^(\d+)\.\s+(.+)$', stripped)
        if m:
            items = []
            while i < len(lines) and re.match(r'^\d+\.\s+', lines[i].strip()):
                items.append(inline(re.match(r'^\d+\.\s+(.+)$', lines[i].strip()).group(1)))
                i += 1
            html_parts.append('<ol>\n')
            for item in items:
                html_parts.append(f'  <li>{item}</li>\n')
            html_parts.append('</ol>\n')
            continue

        # 일반 텍스트
        para = []
        while i < len(lines) and lines[i].strip() and \
              not lines[i].strip().startswith('#') and \
              not lines[i].strip().startswith('!') and \
              not lines[i].strip().startswith('>') and \
              not re.match(r'^[-*]\s+', lines[i].strip()) and \
              not re.match(r'^\d+\.\s+', lines[i].strip()) and \
              '|' not in lines[i] and \
              lines[i].strip() not in ('---', '***', '___'):
            para.append(lines[i].strip())
            i += 1
        if para:
            html_parts.append(f'<p>{inline(" ".join(para))}</p>\n')

    # 남은 테이블 flush
    if in_table:
        html_parts.append(flush_table())

    body = ''.join(html_parts)

    return f'''<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{title}</title>
<style>
  @import url('https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css');
  * {{ margin: 0; padding: 0; box-sizing: border-box; }}
  body {{
    font-family: 'Pretendard Variable', 'Segoe UI', sans-serif;
    line-height: 1.7; color: #1e1b4b; background: #f8f7ff;
    max-width: 900px; margin: 0 auto; padding: 40px 32px;
  }}
  h1 {{
    font-size: 28px; color: #4f46e5; border-bottom: 3px solid #4f46e5;
    padding-bottom: 10px; margin: 36px 0 16px;
  }}
  h2 {{
    font-size: 22px; color: #312e81; border-bottom: 1px solid #e5e7eb;
    padding-bottom: 6px; margin: 30px 0 12px;
  }}
  h3 {{ font-size: 17px; color: #3730a3; margin: 22px 0 8px; }}
  h4 {{ font-size: 15px; color: #4338ca; margin: 16px 0 6px; }}
  p {{ margin: 6px 0 10px; font-size: 15px; }}
  strong {{ color: #1e1b4b; }}
  code {{
    background: #f3f4f6; color: #b91c1c; padding: 2px 6px;
    border-radius: 4px; font-size: 13px; font-family: 'JetBrains Mono', monospace;
  }}
  a {{ color: #4f46e5; text-decoration: none; }}
  a:hover {{ text-decoration: underline; }}
  hr {{ border: none; border-top: 1px solid #e5e7eb; margin: 24px 0; }}
  figure {{
    margin: 16px 0; text-align: center;
    background: white; border: 1px solid #e5e7eb; border-radius: 8px;
    padding: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.06);
  }}
  figure img {{
    max-width: 100%; height: auto; border-radius: 4px;
  }}
  figcaption {{
    font-size: 12px; color: #6b7280; margin-top: 8px; font-style: italic;
  }}
  blockquote {{
    background: #fff7ed; border-left: 4px solid #f59e0b;
    padding: 12px 16px; margin: 12px 0; border-radius: 0 6px 6px 0;
    color: #92400e; font-size: 14px;
  }}
  ul, ol {{ margin: 8px 0 12px 24px; font-size: 15px; }}
  li {{ margin: 3px 0; }}
  .table-wrap {{
    overflow-x: auto; margin: 12px 0;
    border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.08);
  }}
  table {{
    width: 100%; border-collapse: collapse; font-size: 14px; background: white;
  }}
  th {{
    background: #4f46e5; color: white; padding: 10px 12px;
    text-align: left; font-weight: 600;
  }}
  td {{
    padding: 8px 12px; border-bottom: 1px solid #e5e7eb;
  }}
  tr:nth-child(even) td {{ background: #f9fafb; }}
  .missing {{ color: #dc2626; font-style: italic; }}
  @media print {{
    body {{ max-width: 100%; padding: 20px; background: white; }}
    figure {{ break-inside: avoid; }}
    h1, h2, h3 {{ break-after: avoid; }}
  }}
</style>
</head>
<body>
{body}
</body>
</html>'''


if __name__ == '__main__':
    project = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    docs = os.path.join(project, 'docs')

    files = [
        ('manual-admin.md', 'manual-admin.html', 'PMC-AUTO 관리자 사용설명서'),
        ('manual-staff.md', 'manual-staff.html', 'PMC-AUTO 직원 사용설명서'),
    ]

    for md_name, html_name, title in files:
        md_path = os.path.join(docs, md_name)
        html_path = os.path.join(project, html_name)
        if os.path.exists(md_path):
            print(f"변환 중: {md_name} → {html_name}")
            with open(md_path, 'r', encoding='utf-8') as f:
                md_text = f.read()
            html = md_to_html(md_text, docs, title)
            with open(html_path, 'w', encoding='utf-8') as f:
                f.write(html)
            size_kb = os.path.getsize(html_path) / 1024
            print(f"  완료: {html_path} ({size_kb:.0f}KB)")
        else:
            print(f"  파일 없음: {md_path}")

    print("\n완료!")
