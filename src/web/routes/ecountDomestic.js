'use strict';

/**
 * /api/ecount-domestic — ecountERP 의 국내 쇼핑몰 (네이버/쿠팡) 주문을 모아
 * 배송 관리 화면에 표시 + 우체국 자동 송장 발급.
 *
 * 사장님 spec (2026-06-23):
 *   - ecountERP 의 국내 쇼핑몰 (naver, coupang 등) 주문만 골라 별도 섹션으로 표시
 *   - 출력 = 우체국 API 자동 송장 발급 (createParcel domestic=true)
 *
 * Phase 1: 진단 + 미리보기
 * Phase 2: 화면 표시 + list
 * Phase 3: 우체국 라벨 발급
 */
const express = require('express');
const { requireAdmin } = require('../../middleware/auth');
const EcountAPI = require('../../api/ecountAPI');
const { getKoreaPostAPI } = require('../../api/koreaPostAPI');

const router = express.Router();
router.use(requireAdmin);

// ecount platform 코드 중 '국내' 로 분류할 것 — 사장님 spec.
const DOMESTIC_PLATFORMS = ['naver', 'coupang'];

// ════════════════════════════════════════════════════════════════════════════
// GET /api/ecount-domestic/diag — Phase 1 진단
//   ecount 자격증명, 우체국 자격증명, 발송인 정보, 국내 주문 분포 한 번에 확인
// ════════════════════════════════════════════════════════════════════════════
router.get('/diag', async (req, res) => {
  try {
    const days = Math.max(1, Math.min(30, parseInt(req.query.days, 10) || 7));

    // ── ecount 자격증명 ──
    const ecountEnv = {
      ECOUNT_COM_CODE:  !!process.env.ECOUNT_COM_CODE,
      ECOUNT_USER_ID:   !!process.env.ECOUNT_USER_ID,
      ECOUNT_API_KEY:   !!process.env.ECOUNT_API_KEY,
      ECOUNT_ZONE:      !!process.env.ECOUNT_ZONE,
    };
    const ecountConfigured = ecountEnv.ECOUNT_COM_CODE && ecountEnv.ECOUNT_USER_ID && ecountEnv.ECOUNT_API_KEY;

    let ecountSession = null;
    if (ecountConfigured) {
      try {
        const api = new EcountAPI();
        await api.getSession();
        ecountSession = { ok: true };
      } catch (e) {
        ecountSession = { ok: false, error: e.message };
      }
    }

    // ── 우체국 자격증명 ──
    const koreapostEnv = {
      KOREAPOST_API_KEY:               !!process.env.KOREAPOST_API_KEY,
      KOREAPOST_CUSTNO:                !!process.env.KOREAPOST_CUSTNO,
      KOREAPOST_DOMESTIC_LABEL_URL:    !!process.env.KOREAPOST_DOMESTIC_LABEL_URL,  // 기본값 있으니 선택
      KOREAPOST_SHIPPER_NAME:          !!process.env.KOREAPOST_SHIPPER_NAME,
      KOREAPOST_SHIPPER_TEL:           !!process.env.KOREAPOST_SHIPPER_TEL,
      KOREAPOST_SHIPPER_ZIP:           !!process.env.KOREAPOST_SHIPPER_ZIP,
      KOREAPOST_SHIPPER_ADDR:          !!process.env.KOREAPOST_SHIPPER_ADDR,
    };
    const kp = getKoreaPostAPI();
    const koreapostConfigured = kp.isConfigured();

    // ── ecount 국내 (naver/coupang) 주문 분포 ──
    let domesticOrders = null;
    if (ecountConfigured && ecountSession?.ok) {
      try {
        const api = new EcountAPI();
        const startDate = EcountAPI.daysAgo(days);
        const endDate = EcountAPI.today();
        const breakdown = {};
        let totalRaw = 0;
        const samples = [];
        for (const platform of DOMESTIC_PLATFORMS) {
          const rows = await api.getOrders({ startDate, endDate, platform });
          breakdown[platform] = rows.length;
          totalRaw += rows.length;
          // 첫 3개씩 sample (normalize 후)
          for (let i = 0; i < Math.min(3, rows.length); i++) {
            const o = api.normalizeOrder(rows[i]);
            samples.push({ platform, raw_OrderNo: rows[i].ORDER_NO || rows[i].MALL_ORDER_NO, ...o });
          }
        }
        domesticOrders = {
          days,
          startDate, endDate,
          breakdown,
          totalRaw,
          samples,
        };
      } catch (e) {
        domesticOrders = { error: e.message };
      }
    }

    const missingEcount = Object.entries(ecountEnv).filter(([k, v]) => !v && k !== 'ECOUNT_ZONE').map(([k]) => k);
    const missingKoreapost = Object.entries(koreapostEnv).filter(([k, v]) => !v && k !== 'KOREAPOST_DOMESTIC_LABEL_URL').map(([k]) => k);

    // SEED-128 자가 진단 (KOREAPOST_SEED_KEY 있을 때)
    let seedTest = null;
    try {
      seedTest = kp.testSeed();
    } catch (e) {
      seedTest = { ok: false, error: e.message };
    }

    // 실제 우체국 API call 검증 — ?probeKorea=1 일 때만 (production 영향 X)
    let liveProbe = null;
    if (req.query.probeKorea === '1' && koreapostConfigured) {
      liveProbe = {};
      // 1) 국내 계약승인번호 조회 (ship.epost.go.kr) — Host header 빼야 정상
      try {
        const r = await kp.listDomesticContracts();
        liveProbe.domesticContracts = { ok: true, contracts: r.contractInfo };
      } catch (e) {
        liveProbe.domesticContracts = { ok: false, error: e.message };
      }
      // 2) 국내 공급지 list 조회 — officeSer 환경변수 채우기 위해
      try {
        const r = await kp.listDomesticOffices();
        liveProbe.domesticOffices = { ok: true, offices: r.offices };
      } catch (e) {
        liveProbe.domesticOffices = { ok: false, error: e.message };
      }
    }

    res.json({
      ecount: {
        configured: ecountConfigured,
        env: ecountEnv,
        sessionTest: ecountSession,
        missing: missingEcount,
      },
      koreapost: {
        configured: koreapostConfigured,
        env: koreapostEnv,
        missing: missingKoreapost,
        seedTest,
        liveProbe,    // ?probeKorea=1 일 때만 — 실제 우체국 API 호출 결과
      },
      domesticOrders,
      hint: !ecountConfigured
        ? `Railway 환경변수에 [${missingEcount.join(', ')}] 설정 필요`
        : !koreapostConfigured
          ? `Railway 환경변수에 [${missingKoreapost.join(', ')}] 설정 필요`
          : '✅ 모두 정상 — Phase 2 (화면 표시) + Phase 3 (라벨 발급) 진행 가능',
    });
  } catch (e) {
    console.error('[ecount-domestic/diag] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// POST /api/ecount-domestic/test-domestic-label
//   국내 우체국 소포신청 테스트 라벨 발급 (testYn='Y' → 실제 접수 X, 검증만)
//
//   사장님이 sample 주문 정보로 호출 → 정상 응답 (regiNo) 받으면 라벨 발급 흐름
//   전체 OK. 그 다음 Phase 2 (배송 관리 UI) 통합 진행.
//
//   body (전부 선택 — 안 보내면 sample 사용):
//     orderNo, weight, volume, recipient: { name, zip, addr1, addr2, tel, mob },
//     parcel: { contCd, goodsNm, qty }, testYn='Y' (default — 'N' 이면 실제 접수)
// ════════════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════════════
// POST /api/ecount-domestic/koreapost-label-from-order
//   기존 orders 테이블 (Supabase) 의 한국 주문 → 우체국 국내 라벨 발급.
//
//   사장님 결정 2026-06-27 (Phase A):
//     - ecount sync (IP 차단) 우회. 기존 orders 사용.
//     - 한국 주소 (country_code='KR' 또는 빈 값) 주문에 라벨 발급.
//
//   body:
//     orderNo (필수)
//     testYn: 'Y' (기본, 안전) | 'N' (실제 접수 + 청구)
//     weightKg, dimensions: orders 의 값 override (없으면 orders 값 사용)
//
//   처리:
//     1. orders 조회 + country/주소 검증
//     2. createDomesticOrder() 호출
//     3. orders 업데이트: carrier='우체국', tracking_no=regiNo, status='SHIPPED' (testYn='N' 만)
// ════════════════════════════════════════════════════════════════════════════
router.post('/koreapost-label-from-order', async (req, res) => {
  try {
    const { orderNo, testYn: testYnRaw } = req.body || {};
    if (!orderNo) return res.status(400).json({ ok: false, error: 'orderNo 필수' });
    const testYn = testYnRaw === 'N' ? 'N' : 'Y';   // default 안전

    const { getClient } = require('../../db/supabaseClient');
    const db = getClient();
    const { data: order, error } = await db.from('orders')
      .select(`
        id, order_no, sku, title, quantity,
        buyer_name, country, country_code,
        street, city, province, zip_code, phone, email,
        weight_kg, box_length, box_width, box_height,
        payment_amount, currency, carrier, status, tracking_no
      `)
      .eq('order_no', orderNo)
      .maybeSingle();
    if (error) throw error;
    if (!order) return res.status(404).json({ ok: false, error: `주문 ${orderNo} 없음` });

    // 한국 주소 검증 — country_code 가 'KR' 또는 빈값 또는 'KOR' 또는 한국
    const cc = String(order.country_code || '').trim().toUpperCase();
    const ctyName = String(order.country || '').trim();
    const isKorean = !cc || cc === 'KR' || cc === 'KOR' || /한국|korea/i.test(ctyName);
    if (!isKorean) {
      return res.status(400).json({
        ok: false,
        error: `한국 주소 아님 — country_code='${cc || '(빈값)'}' country='${ctyName}'. 우체국 국내 라벨은 한국 주소만 가능.`,
      });
    }
    if (!order.buyer_name || !order.zip_code || !order.street) {
      return res.status(400).json({
        ok: false,
        error: `주소 불완전 — buyer_name, zip_code, street 모두 필요`,
      });
    }
    if (testYn === 'N' && order.tracking_no) {
      return res.status(409).json({
        ok: false,
        error: `이미 운송장 발급된 주문 (tracking_no=${order.tracking_no}). 중복 발급 방지.`,
      });
    }

    // 무게/치수
    const weightKg = Number(order.weight_kg) || 1;     // 매뉴얼: 정수 kg 필요
    const volume = (Number(order.box_length) || 20)
                 + (Number(order.box_width)  || 20)
                 + (Number(order.box_height) || 20);   // 가로+세로+높이 합

    const kp = getKoreaPostAPI();
    if (!kp.isConfigured()) {
      return res.status(503).json({ ok: false, error: 'KOREAPOST_API_KEY 미설정' });
    }

    // 매뉴얼 line 716: weight 길이 2자, volume 3자. 정수 변환.
    const result = await kp.createDomesticOrder({
      order: {
        orderNo: String(order.order_no).slice(0, 50),
        ordCompNm: 'PMC Corporation',
        recipient: {
          name:  order.buyer_name,
          zip:   String(order.zip_code).replace(/\D/g, '').slice(0, 5),  // 5자리 숫자만
          addr1: order.street,
          addr2: [order.city, order.province].filter(Boolean).join(' ').slice(0, 300) || '',
          tel:   (order.phone || '').replace(/\D/g, '').slice(0, 12),
          mob:   (order.phone || '').replace(/\D/g, '').slice(0, 12),
        },
        parcel: {
          weight: Math.max(1, Math.round(weightKg)),
          volume: Math.max(10, Math.round(volume)),
          contCd: '021',                                  // 일반 상품
          goodsNm: String(order.title || 'PMC 발송').slice(0, 400),
          qty:    Number(order.quantity) || 1,
          microYn: 'N',
        },
      },
      payType: '1',
      reqType: '1',
      testYn,
    });

    // testYn='N' 만 orders 업데이트 (실제 발송)
    let dbUpdate = null;
    if (testYn === 'N' && result.regiNo) {
      try {
        await db.from('orders').update({
          carrier: '우체국',
          tracking_no: result.regiNo,
          status: 'SHIPPED',
        }).eq('order_no', orderNo);
        dbUpdate = { ok: true, carrier: '우체국', tracking_no: result.regiNo };
      } catch (e) {
        dbUpdate = { ok: false, error: e.message };
      }
    }

    res.json({
      ok: true,
      testYn,
      orderNo: order.order_no,
      result,
      dbUpdate,
      hint: testYn === 'Y'
        ? '✅ 테스트 모드 — 실제 접수 X. result.regiNo 받으면 발급 흐름 정상. 실제 발송 시 testYn=N 재호출.'
        : '⚠️ 실제 접수됨 — result.regiNo 가 진짜 운송장 번호. PMC 계정 청구 + orders 업데이트됨.',
    });
  } catch (e) {
    console.error('[koreapost-label-from-order] error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/test-domestic-label', async (req, res) => {
  try {
    const body = req.body || {};
    const testYn = (body.testYn === 'N') ? 'N' : 'Y';   // default Y (안전)
    const useAscii = body.ascii === true;                // ASCII only (한글 인코딩 문제 격리)
    const debug = body.debug === true;                   // 평문 + regData 같이 반환

    const orderNo = body.orderNo
      || `TEST-${Date.now().toString().slice(-10)}`;

    // sample 주문 정보 — ascii=true 면 한글 일체 없는 영문 sample
    const order = useAscii ? {
      orderNo,
      ordCompNm: body.ordCompNm || 'PMC Corporation',
      recipient: {
        name:  'Hong Gildong',
        zip:   '04524',
        addr1: '110 Sejong-daero, Jung-gu',
        addr2: 'Seoul City Hall',
        tel:   '',
        mob:   '01012345678',
      },
      parcel: {
        weight: 1, volume: 60, contCd: '021',
        goodsNm: 'PMC Test Item',
        qty: 1, microYn: 'N',
      },
    } : {
      orderNo,
      ordCompNm: body.ordCompNm || 'PMC Corporation',
      recipient: {
        name:  body.recipient?.name  || '홍길동',
        zip:   body.recipient?.zip   || '04524',
        addr1: body.recipient?.addr1 || '서울 중구 세종대로 110',
        addr2: body.recipient?.addr2 || '(을지로1가, 서울특별시청)',
        tel:   body.recipient?.tel   || '',
        mob:   body.recipient?.mob   || '01012345678',
      },
      parcel: {
        weight: body.parcel?.weight || 1,
        volume: body.parcel?.volume || 60,
        contCd: body.parcel?.contCd || '021',
        goodsNm: body.parcel?.goodsNm || 'PMC 테스트 발송',
        qty:    body.parcel?.qty    || 1,
        microYn: 'N',
      },
    };

    const kp = getKoreaPostAPI();
    if (!kp.isConfigured()) {
      return res.status(503).json({ ok: false, error: 'KOREAPOST_API_KEY 미설정' });
    }

    // debug 모드: 평문 + regData 미리 계산해서 응답에 포함 (실제 호출 전)
    let debugInfo = null;
    if (debug) {
      const r = order.recipient;
      const p = order.parcel;
      const plainParams = {
        custNo: kp.custno,
        apprNo: kp.apprnoDomestic,
        payType: '1',
        reqType: '1',
        officeSer: kp.domesticOfficeSer,
        weight: p.weight, volume: p.volume, microYn: p.microYn || 'N',
        orderNo: order.orderNo,
        ordCompNm: order.ordCompNm,
        recNm: r.name, recZip: r.zip, recAddr1: r.addr1, recAddr2: r.addr2 || '',
        recTel: r.tel || '', recMob: r.mob || '',
        contCd: p.contCd, goodsNm: p.goodsNm, qty: p.qty,
        testYn, printYn: 'N',
      };
      const plain = Object.entries(plainParams)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${k}=${v}`).join('&');
      const seed = require('../../lib/seed128');
      const regData = seed.encrypt(process.env.KOREAPOST_SEED_KEY || '', plain);
      const roundTrip = seed.decrypt(process.env.KOREAPOST_SEED_KEY || '', regData);
      debugInfo = {
        plainChars: plain.length,
        plainBytes: new TextEncoder().encode(plain).length,
        plain,
        regDataLen: regData.length,
        regData,
        roundTripOk: roundTrip === plain,
        roundTripValue: roundTrip,
        envCheck: {
          custno: !!kp.custno,
          apprnoDomestic: !!kp.apprnoDomestic,
          officeSer: !!kp.domesticOfficeSer,
          seedKey: !!(process.env.KOREAPOST_SEED_KEY),
        },
      };
    }

    try {
      const result = await kp.createDomesticOrder({
        order,
        payType: '1',
        reqType: '1',
        testYn,
      });
      res.json({ ok: true, testYn, useAscii, orderNo, result, debugInfo });
    } catch (e) {
      // 에러 시에도 debugInfo 반환 — 어떤 평문/regData 가 보내졌는지 확인 가능
      res.status(500).json({ ok: false, error: e.message, debugInfo });
    }
  } catch (e) {
    console.error('[ecount-domestic/test-domestic-label] error:', e.message);
    res.status(500).json({ ok: false, error: e.message, stack: e.stack?.split('\n').slice(0, 5) });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /api/ecount-domestic/orders — Phase 2 화면용 list
//   ecount naver + coupang 주문 정규화해서 한 배열로 반환
// ════════════════════════════════════════════════════════════════════════════
router.get('/orders', async (req, res) => {
  try {
    const days = Math.max(1, Math.min(30, parseInt(req.query.days, 10) || 7));
    const api = new EcountAPI();
    const startDate = EcountAPI.daysAgo(days);
    const endDate = EcountAPI.today();

    const all = [];
    const errors = [];
    for (const platform of DOMESTIC_PLATFORMS) {
      try {
        const rows = await api.getOrders({ startDate, endDate, platform });
        for (const r of rows) {
          const norm = api.normalizeOrder(r);
          all.push({
            ...norm,
            ecountPlatform: platform,
            ecountRaw: { ORDER_NO: r.ORDER_NO, MALL_ORDER_NO: r.MALL_ORDER_NO, WRT_DATE: r.WRT_DATE },
          });
        }
      } catch (e) {
        errors.push(`${platform}: ${e.message}`);
      }
    }

    // 최신 순 정렬
    all.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

    res.json({
      ok: true,
      days, startDate, endDate,
      count: all.length,
      errors,
      orders: all,
    });
  } catch (e) {
    console.error('[ecount-domestic/orders] error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
