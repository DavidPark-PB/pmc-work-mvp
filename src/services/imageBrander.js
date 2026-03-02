const sharp = require('sharp');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const UPLOADS_DIR = path.join(__dirname, '../../public/uploads');
const TEMPLATES_DIR = path.join(__dirname, '../../public/uploads/templates');
const ASSETS_DIR = path.join(__dirname, '../../public/assets');

class ImageBrander {
  constructor(options = {}) {
    this.watermarkText = options.watermarkText || 'PMC Corporation';
    this.borderColor = options.borderColor || '#1a1a2e';
    this.borderWidth = options.borderWidth || 4;
    this.brightness = options.brightness || 1.05;
    this.contrast = options.contrast || 1.1;
    this.saturation = options.saturation || 1.05;

    [UPLOADS_DIR, TEMPLATES_DIR, ASSETS_DIR].forEach(dir => {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    });
  }

  /**
   * 이미지 URL 목록을 다운로드 → 브랜딩 처리 → 로컬 저장
   * @param {string[]} imageUrls
   * @param {string} sku
   * @returns {Object[]} [{ original, branded, filename }]
   */
  async brandImages(imageUrls, sku, templateOpts = {}) {
    const results = [];

    for (let i = 0; i < imageUrls.length; i++) {
      try {
        let result;
        if (templateOpts.template) {
          result = await this.brandWithTemplate(imageUrls[i], sku, i + 1, templateOpts);
        } else {
          result = await this.brandSingleImage(imageUrls[i], sku, i + 1);
        }
        results.push(result);
      } catch (err) {
        console.error(`이미지 브랜딩 실패 [${i + 1}]:`, err.message);
        results.push({ original: imageUrls[i], branded: imageUrls[i], filename: null, error: err.message });
      }
    }

    return results;
  }

  /**
   * 단일 이미지 브랜딩 처리
   */
  async brandSingleImage(imageUrl, sku, index) {
    // 1. 이미지 다운로드
    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const inputBuffer = Buffer.from(response.data);

    // 2. 원본 메타데이터
    const metadata = await sharp(inputBuffer).metadata();
    const width = metadata.width || 800;
    const height = metadata.height || 800;

    // 3. 워터마크 SVG 생성
    const watermarkSvg = this._createWatermarkSvg(width, height);

    // 4. 테두리 SVG (하단 브랜드 바)
    const brandBarSvg = this._createBrandBarSvg(width);
    const brandBarHeight = 36;

    // 5. 이미지 처리 파이프라인
    const processed = await sharp(inputBuffer)
      .resize(width, height, { fit: 'inside', withoutEnlargement: true })
      // 밝기/대비/채도 보정
      .modulate({ brightness: this.brightness, saturation: this.saturation })
      .linear(this.contrast, -(128 * this.contrast - 128))
      // 워터마크 합성
      .composite([
        {
          input: Buffer.from(watermarkSvg),
          gravity: 'southeast',
        }
      ])
      .toBuffer();

    // 6. 하단 브랜드 바 추가 (이미지 아래에 붙이기)
    const brandBar = await sharp(Buffer.from(brandBarSvg))
      .resize(width, brandBarHeight)
      .png()
      .toBuffer();

    const finalImage = await sharp(processed)
      .extend({
        bottom: brandBarHeight,
        background: '#1a1a2e'
      })
      .composite([
        {
          input: brandBar,
          gravity: 'south',
        }
      ])
      .jpeg({ quality: 92 })
      .toBuffer();

    // 7. 저장
    const filename = `${sku}-${index}-${Date.now()}.jpg`;
    const filepath = path.join(UPLOADS_DIR, filename);
    fs.writeFileSync(filepath, finalImage);

    return {
      original: imageUrl,
      branded: `/uploads/${filename}`,
      filename,
      size: finalImage.length,
    };
  }

  /**
   * 우하단 반투명 워터마크
   */
  _createWatermarkSvg(imgWidth, imgHeight) {
    const fontSize = Math.max(12, Math.floor(imgWidth * 0.025));
    return `<svg width="${imgWidth}" height="${imgHeight}">
      <style>
        .wm { fill: rgba(255,255,255,0.5); font-size: ${fontSize}px; font-family: Arial, sans-serif; font-weight: bold; }
      </style>
      <text x="${imgWidth - 10}" y="${imgHeight - 12}" text-anchor="end" class="wm">${this.watermarkText}</text>
    </svg>`;
  }

  /**
   * 하단 브랜드 바 (로고 텍스트 + 배경)
   */
  _createBrandBarSvg(imgWidth) {
    return `<svg width="${imgWidth}" height="36">
      <rect width="${imgWidth}" height="36" fill="#1a1a2e"/>
      <text x="${imgWidth / 2}" y="23" text-anchor="middle" fill="#e94560" font-size="14" font-family="Arial, sans-serif" font-weight="bold">
        PMC Corporation — Premium Quality Verified
      </text>
    </svg>`;
  }

  /**
   * 템플릿 기반 이미지 합성
   * - template='auto': 코드로 생성 (상단 텍스트 + 상품 사진 + 하단 로고 + 워터마크)
   * - template='파일명.png': 업로드된 PNG 템플릿에 상품 사진 합성
   */
  async brandWithTemplate(imageUrl, sku, index, opts = {}) {
    const { template, topText, showShippingLogos = true } = opts;

    // 이미지 다운로드
    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const inputBuffer = Buffer.from(response.data);

    let finalImage;

    if (template === 'auto') {
      finalImage = await this._autoTemplate(inputBuffer, { topText, showShippingLogos });
    } else {
      // PNG 템플릿 파일 사용
      const templatePath = path.join(TEMPLATES_DIR, template);
      if (!fs.existsSync(templatePath)) {
        throw new Error(`템플릿 파일을 찾을 수 없습니다: ${template}`);
      }
      finalImage = await this._pngTemplate(inputBuffer, templatePath);
    }

    const filename = `${sku}-${index}-${Date.now()}.jpg`;
    const filepath = path.join(UPLOADS_DIR, filename);
    fs.writeFileSync(filepath, finalImage);

    return {
      original: imageUrl,
      branded: `/uploads/${filename}`,
      filename,
      size: finalImage.length,
    };
  }

  /**
   * 자동 생성 템플릿: 흰 배경 + 상단 텍스트 + 상품 사진 + 하단 로고 + 워터마크
   */
  async _autoTemplate(imageBuffer, { topText = '', showShippingLogos = true }) {
    const canvasW = 1000;
    const canvasH = 1000;
    const topH = topText ? 120 : 0;
    const bottomH = showShippingLogos ? 100 : 0;
    const photoAreaH = canvasH - topH - bottomH;

    // 상품 사진 리사이즈 (여백 포함)
    const photoSize = Math.min(photoAreaH - 40, canvasW - 80);
    const productImg = await sharp(imageBuffer)
      .resize(photoSize, photoSize, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
      .toBuffer();

    const layers = [];

    // 상단 텍스트 SVG
    if (topText) {
      const topSvg = `<svg width="${canvasW}" height="${topH}">
        <rect width="${canvasW}" height="${topH}" fill="#ffffff"/>
        <text x="${canvasW / 2}" y="${topH * 0.65}" text-anchor="middle" font-size="64" font-family="Arial, sans-serif" font-weight="900" fill="#1a1a2e">${this._escXml(topText)}</text>
      </svg>`;
      layers.push({ input: Buffer.from(topSvg), top: 0, left: 0 });
    }

    // 상품 사진 (중앙)
    const photoTop = topH + Math.round((photoAreaH - photoSize) / 2);
    const photoLeft = Math.round((canvasW - photoSize) / 2);
    layers.push({ input: productImg, top: photoTop, left: photoLeft });

    // 하단 배송 로고
    if (showShippingLogos) {
      const logoSvg = this._createShippingLogoSvg(canvasW, bottomH);
      layers.push({ input: Buffer.from(logoSvg), top: canvasH - bottomH, left: 0 });
    }

    // 워터마크
    const wmSvg = this._createWatermarkSvg(canvasW, canvasH);
    layers.push({ input: Buffer.from(wmSvg), top: 0, left: 0 });

    // 합성
    const finalImage = await sharp({
      create: { width: canvasW, height: canvasH, channels: 3, background: { r: 255, g: 255, b: 255 } }
    })
      .composite(layers)
      .jpeg({ quality: 92 })
      .toBuffer();

    return finalImage;
  }

  /**
   * PNG 템플릿에 상품 사진 합성 (투명/흰 영역에 중앙 배치)
   */
  async _pngTemplate(imageBuffer, templatePath) {
    const templateMeta = await sharp(templatePath).metadata();
    const tw = templateMeta.width || 1000;
    const th = templateMeta.height || 1000;

    // 상품 사진을 템플릿 크기의 55%로 리사이즈
    const photoSize = Math.round(Math.min(tw, th) * 0.55);
    const productImg = await sharp(imageBuffer)
      .resize(photoSize, photoSize, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } })
      .png()
      .toBuffer();

    // 배경 흰색 캔버스 + 상품 사진 (중앙) + 템플릿 오버레이
    const photoTop = Math.round((th - photoSize) / 2);
    const photoLeft = Math.round((tw - photoSize) / 2);

    const finalImage = await sharp({
      create: { width: tw, height: th, channels: 3, background: { r: 255, g: 255, b: 255 } }
    })
      .composite([
        { input: productImg, top: photoTop, left: photoLeft },
        { input: templatePath, top: 0, left: 0 },
      ])
      .jpeg({ quality: 92 })
      .toBuffer();

    return finalImage;
  }

  /**
   * 배송 로고 SVG (DHL + FedEx 텍스트 스타일)
   */
  _createShippingLogoSvg(width, height) {
    const halfW = width / 2;
    return `<svg width="${width}" height="${height}">
      <rect width="${width}" height="${height}" fill="#ffffff"/>
      <line x1="${halfW}" y1="10" x2="${halfW}" y2="${height - 10}" stroke="#e0e0e0" stroke-width="1"/>
      <rect x="40" y="15" width="${halfW - 80}" height="${height - 30}" rx="8" fill="#FFCC00"/>
      <text x="${halfW / 2}" y="${height * 0.52}" text-anchor="middle" font-size="32" font-family="Arial, sans-serif" font-weight="900" fill="#CC0000">DHL</text>
      <text x="${halfW / 2}" y="${height * 0.82}" text-anchor="middle" font-size="13" font-family="Arial, sans-serif" font-weight="600" fill="#CC0000">EXPRESS</text>
      <text x="${halfW + halfW / 2}" y="${height * 0.55}" text-anchor="middle" font-size="36" font-family="Arial, sans-serif" font-weight="900" fill="#4D148C">FedEx</text>
      <text x="${halfW + halfW / 2}" y="${height * 0.82}" text-anchor="middle" font-size="13" font-family="Arial, sans-serif" font-weight="600" fill="#FF6600">Express</text>
    </svg>`;
  }

  _escXml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /** 업로드된 템플릿 목록 반환 */
  static getTemplateList() {
    if (!fs.existsSync(TEMPLATES_DIR)) return [];
    return fs.readdirSync(TEMPLATES_DIR)
      .filter(f => /\.(png|jpg|jpeg)$/i.test(f))
      .map(f => ({ filename: f, path: `/uploads/templates/${f}` }));
  }
}

module.exports = ImageBrander;
