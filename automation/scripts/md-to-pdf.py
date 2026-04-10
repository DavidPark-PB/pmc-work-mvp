"""
MD → PDF 변환 스크립트
이미지 삽입 + 한글 지원 + 스타일링
"""
import re
import os
import sys
from pathlib import Path

from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm, cm
from reportlab.lib.colors import HexColor, black, white, lightgrey
from reportlab.lib.enums import TA_LEFT, TA_CENTER
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Image, Table, TableStyle,
    PageBreak, HRFlowable, KeepTogether
)
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont


# ─── 한글 폰트 등록 ───
def register_korean_font():
    """Windows에서 Pretendard 또는 맑은고딕 등록"""
    font_dirs = [
        os.path.expanduser("~") + "/AppData/Local/Microsoft/Windows/Fonts",
        "C:/Windows/Fonts",
    ]

    # Pretendard 시도
    for d in font_dirs:
        regular = os.path.join(d, "PretendardVariable.ttf")
        if os.path.exists(regular):
            pdfmetrics.registerFont(TTFont("Korean", regular))
            pdfmetrics.registerFont(TTFont("KoreanBold", regular))
            return "Korean"

    # 맑은고딕 시도
    for d in font_dirs:
        regular = os.path.join(d, "malgun.ttf")
        bold = os.path.join(d, "malgunbd.ttf")
        if os.path.exists(regular):
            pdfmetrics.registerFont(TTFont("Korean", regular))
            if os.path.exists(bold):
                pdfmetrics.registerFont(TTFont("KoreanBold", bold))
            else:
                pdfmetrics.registerFont(TTFont("KoreanBold", regular))
            return "Korean"

    print("WARNING: No Korean font found, using default")
    return "Helvetica"


FONT = register_korean_font()
FONT_BOLD = "KoreanBold" if FONT == "Korean" else "Helvetica-Bold"

# ─── 색상 ───
PRIMARY = HexColor("#4F46E5")
HEADING_BG = HexColor("#F0EEFF")
TABLE_HEADER_BG = HexColor("#4F46E5")
TABLE_STRIPE = HexColor("#F9FAFB")
BLOCKQUOTE_BG = HexColor("#FFF7ED")
BLOCKQUOTE_BORDER = HexColor("#F59E0B")
HR_COLOR = HexColor("#E5E7EB")
CODE_BG = HexColor("#F3F4F6")


# ─── 스타일 정의 ───
def make_styles():
    styles = getSampleStyleSheet()

    styles.add(ParagraphStyle(
        'KTitle', fontName=FONT_BOLD, fontSize=22, leading=28,
        textColor=PRIMARY, spaceAfter=8, spaceBefore=4,
    ))
    styles.add(ParagraphStyle(
        'KH1', fontName=FONT_BOLD, fontSize=18, leading=24,
        textColor=HexColor("#1E1B4B"), spaceBefore=20, spaceAfter=8,
        borderWidth=0, borderPadding=0,
    ))
    styles.add(ParagraphStyle(
        'KH2', fontName=FONT_BOLD, fontSize=15, leading=20,
        textColor=HexColor("#312E81"), spaceBefore=16, spaceAfter=6,
    ))
    styles.add(ParagraphStyle(
        'KH3', fontName=FONT_BOLD, fontSize=13, leading=18,
        textColor=HexColor("#3730A3"), spaceBefore=12, spaceAfter=4,
    ))
    styles.add(ParagraphStyle(
        'KBody', fontName=FONT, fontSize=10, leading=16,
        spaceBefore=2, spaceAfter=4,
    ))
    styles.add(ParagraphStyle(
        'KBullet', fontName=FONT, fontSize=10, leading=16,
        leftIndent=16, bulletIndent=6, spaceBefore=1, spaceAfter=1,
    ))
    styles.add(ParagraphStyle(
        'KBlockquote', fontName=FONT, fontSize=9.5, leading=15,
        leftIndent=12, textColor=HexColor("#92400E"),
        spaceBefore=6, spaceAfter=6,
    ))
    styles.add(ParagraphStyle(
        'KTableCell', fontName=FONT, fontSize=9, leading=13,
    ))
    styles.add(ParagraphStyle(
        'KTableHeader', fontName=FONT_BOLD, fontSize=9, leading=13,
        textColor=white,
    ))
    styles.add(ParagraphStyle(
        'KTOC', fontName=FONT, fontSize=10, leading=16,
        leftIndent=12, spaceBefore=1, spaceAfter=1,
        textColor=PRIMARY,
    ))
    return styles


# ─── MD 파싱 ───
def inline_format(text, font=FONT, bold_font=FONT_BOLD):
    """인라인 마크다운 → ReportLab XML 변환"""
    # 볼드
    text = re.sub(r'\*\*(.+?)\*\*', rf'<font name="{bold_font}">\1</font>', text)
    # 인라인 코드
    text = re.sub(r'`([^`]+)`', r'<font name="Courier" size="9" color="#B91C1C">\1</font>', text)
    # 링크 (텍스트만)
    text = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', text)
    return text


def parse_md_to_flowables(md_text: str, base_dir: str, styles):
    """마크다운 텍스트 → ReportLab flowable 리스트"""
    flowables = []
    lines = md_text.split('\n')
    i = 0

    page_width = A4[0] - 50*mm  # 양쪽 마진 제외

    while i < len(lines):
        line = lines[i]
        stripped = line.strip()

        # 빈 줄
        if not stripped:
            i += 1
            continue

        # 수평선
        if stripped in ('---', '***', '___'):
            flowables.append(Spacer(1, 4*mm))
            flowables.append(HRFlowable(width="100%", thickness=1, color=HR_COLOR))
            flowables.append(Spacer(1, 4*mm))
            i += 1
            continue

        # 헤딩
        heading_match = re.match(r'^(#{1,4})\s+(.+)$', stripped)
        if heading_match:
            level = len(heading_match.group(1))
            text = heading_match.group(2)
            text = inline_format(text)

            if level == 1:
                flowables.append(Spacer(1, 4*mm))
                flowables.append(Paragraph(text, styles['KTitle']))
                flowables.append(HRFlowable(width="100%", thickness=2, color=PRIMARY))
                flowables.append(Spacer(1, 4*mm))
            elif level == 2:
                flowables.append(Spacer(1, 3*mm))
                flowables.append(Paragraph(text, styles['KH1']))
                flowables.append(HRFlowable(width="60%", thickness=1, color=HR_COLOR))
                flowables.append(Spacer(1, 2*mm))
            elif level == 3:
                flowables.append(Paragraph(text, styles['KH2']))
            elif level == 4:
                flowables.append(Paragraph(text, styles['KH3']))
            i += 1
            continue

        # 이미지
        img_match = re.match(r'^!\[([^\]]*)\]\(([^)]+)\)', stripped)
        if img_match:
            alt = img_match.group(1)
            src = img_match.group(2)
            img_path = os.path.join(base_dir, src)

            if os.path.exists(img_path):
                try:
                    from PIL import Image as PILImage
                    pil_img = PILImage.open(img_path)
                    img_w, img_h = pil_img.size

                    # 큰 이미지는 리사이즈해서 tmp에 저장
                    resized_path = img_path
                    if img_w > 1200:
                        new_w = 1200
                        new_h = int(img_h * (new_w / img_w))
                        pil_img = pil_img.resize((new_w, new_h), PILImage.LANCZOS)
                        resized_path = img_path + ".tmp.png"
                        pil_img.save(resized_path, "PNG", optimize=True)
                        img_w, img_h = new_w, new_h

                    # 페이지 너비에 맞춰 축소
                    max_w = page_width
                    max_h = 180*mm

                    ratio = min(max_w / img_w, max_h / img_h, 1.0)
                    display_w = img_w * ratio
                    display_h = img_h * ratio

                    flowables.append(Spacer(1, 3*mm))
                    img = Image(resized_path, width=display_w, height=display_h)
                    flowables.append(img)
                    if alt:
                        flowables.append(Paragraph(
                            f'<font size="8" color="#6B7280"><i>{alt}</i></font>',
                            styles['KBody']
                        ))
                    flowables.append(Spacer(1, 3*mm))
                except Exception as e:
                    flowables.append(Paragraph(f'[이미지 로드 실패: {src} - {e}]', styles['KBody']))
            else:
                flowables.append(Paragraph(f'[이미지 없음: {src}]', styles['KBody']))
            i += 1
            continue

        # 블록인용
        if stripped.startswith('>'):
            quote_lines = []
            while i < len(lines) and lines[i].strip().startswith('>'):
                quote_lines.append(lines[i].strip().lstrip('>').strip())
                i += 1
            quote_text = inline_format(' '.join(quote_lines))

            # 블록인용 테이블로 시각화
            quote_para = Paragraph(quote_text, styles['KBlockquote'])
            t = Table([[quote_para]], colWidths=[page_width - 8*mm])
            t.setStyle(TableStyle([
                ('BACKGROUND', (0, 0), (-1, -1), BLOCKQUOTE_BG),
                ('BOX', (0, 0), (-1, -1), 0.5, BLOCKQUOTE_BORDER),
                ('LEFTPADDING', (0, 0), (-1, -1), 10),
                ('RIGHTPADDING', (0, 0), (-1, -1), 10),
                ('TOPPADDING', (0, 0), (-1, -1), 8),
                ('BOTTOMPADDING', (0, 0), (-1, -1), 8),
            ]))
            flowables.append(Spacer(1, 2*mm))
            flowables.append(t)
            flowables.append(Spacer(1, 2*mm))
            continue

        # 테이블
        if '|' in stripped and i + 1 < len(lines):
            table_lines = []
            while i < len(lines) and '|' in lines[i].strip():
                table_lines.append(lines[i].strip())
                i += 1

            if len(table_lines) >= 2:
                # 구분선 제거
                rows = []
                for tl in table_lines:
                    if re.match(r'^[\|\s\-:]+$', tl):
                        continue
                    cells = [c.strip() for c in tl.strip('|').split('|')]
                    rows.append(cells)

                if rows:
                    # 헤더 + 데이터
                    num_cols = max(len(r) for r in rows)
                    # 셀 너비 균등 분배
                    col_w = (page_width - 4*mm) / num_cols

                    table_data = []
                    for ri, row in enumerate(rows):
                        # 부족한 셀 채우기
                        while len(row) < num_cols:
                            row.append('')

                        styled_row = []
                        for cell in row:
                            cell_text = inline_format(cell)
                            if ri == 0:
                                styled_row.append(Paragraph(cell_text, styles['KTableHeader']))
                            else:
                                styled_row.append(Paragraph(cell_text, styles['KTableCell']))
                        table_data.append(styled_row)

                    t = Table(table_data, colWidths=[col_w] * num_cols)
                    style_cmds = [
                        ('BACKGROUND', (0, 0), (-1, 0), TABLE_HEADER_BG),
                        ('TEXTCOLOR', (0, 0), (-1, 0), white),
                        ('GRID', (0, 0), (-1, -1), 0.5, HexColor("#D1D5DB")),
                        ('TOPPADDING', (0, 0), (-1, -1), 5),
                        ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
                        ('LEFTPADDING', (0, 0), (-1, -1), 6),
                        ('RIGHTPADDING', (0, 0), (-1, -1), 6),
                        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
                    ]
                    # 줄무늬
                    for ri in range(1, len(table_data)):
                        if ri % 2 == 0:
                            style_cmds.append(('BACKGROUND', (0, ri), (-1, ri), TABLE_STRIPE))

                    t.setStyle(TableStyle(style_cmds))
                    flowables.append(Spacer(1, 2*mm))
                    flowables.append(t)
                    flowables.append(Spacer(1, 2*mm))
            continue

        # 불릿 리스트
        bullet_match = re.match(r'^[-*]\s+(.+)$', stripped)
        if bullet_match:
            text = inline_format(bullet_match.group(1))
            flowables.append(Paragraph(f'•  {text}', styles['KBullet']))
            i += 1
            continue

        # 번호 리스트
        num_match = re.match(r'^(\d+)\.\s+(.+)$', stripped)
        if num_match:
            num = num_match.group(1)
            text = inline_format(num_match.group(2))
            flowables.append(Paragraph(f'{num}.  {text}', styles['KBullet']))
            i += 1
            continue

        # 일반 텍스트 (여러 줄 연결)
        para_lines = []
        while i < len(lines) and lines[i].strip() and \
              not lines[i].strip().startswith('#') and \
              not lines[i].strip().startswith('!') and \
              not lines[i].strip().startswith('>') and \
              not lines[i].strip().startswith('-') and \
              not lines[i].strip().startswith('*') and \
              not re.match(r'^\d+\.', lines[i].strip()) and \
              '|' not in lines[i] and \
              lines[i].strip() not in ('---', '***', '___'):
            para_lines.append(lines[i].strip())
            i += 1

        if para_lines:
            text = inline_format(' '.join(para_lines))
            flowables.append(Paragraph(text, styles['KBody']))

    return flowables


# ─── 페이지 번호 ───
def add_page_number(canvas, doc):
    canvas.saveState()
    canvas.setFont(FONT, 8)
    canvas.setFillColor(HexColor("#9CA3AF"))
    page_num = canvas.getPageNumber()
    canvas.drawRightString(A4[0] - 25*mm, 15*mm, f"- {page_num} -")
    canvas.restoreState()


# ─── 메인 변환 ───
def convert_md_to_pdf(md_path: str, pdf_path: str):
    md_path = os.path.abspath(md_path)
    pdf_path = os.path.abspath(pdf_path)
    base_dir = os.path.dirname(md_path)

    with open(md_path, 'r', encoding='utf-8') as f:
        md_text = f.read()

    styles = make_styles()

    doc = SimpleDocTemplate(
        pdf_path,
        pagesize=A4,
        leftMargin=25*mm,
        rightMargin=25*mm,
        topMargin=20*mm,
        bottomMargin=25*mm,
    )

    flowables = parse_md_to_flowables(md_text, base_dir, styles)

    doc.build(flowables, onFirstPage=add_page_number, onLaterPages=add_page_number)
    print(f"  PDF 생성 완료: {pdf_path}")


if __name__ == '__main__':
    project = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    docs = os.path.join(project, 'docs')

    files = [
        (os.path.join(docs, 'manual-admin.md'), os.path.join(docs, 'manual-admin.pdf')),
        (os.path.join(docs, 'manual-staff.md'), os.path.join(docs, 'manual-staff.pdf')),
    ]

    for md, pdf in files:
        if os.path.exists(md):
            print(f"변환 중: {os.path.basename(md)} → {os.path.basename(pdf)}")
            convert_md_to_pdf(md, pdf)
        else:
            print(f"  파일 없음: {md}")

    print("\n완료!")
