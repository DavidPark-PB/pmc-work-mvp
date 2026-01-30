require('dotenv').config();
const axios = require('axios');
const fs = require('fs');

/**
 * GetMyeBaySelling API 상세 테스트
 * DetailLevel=ReturnAll, 전체 XML 응답 출력
 */

async function testGetMyeBaySelling() {
  const devId = process.env.EBAY_DEV_ID;
  const appId = process.env.EBAY_APP_ID;
  const certId = process.env.EBAY_CERT_ID;
  const userToken = process.env.EBAY_USER_TOKEN;
  const apiUrl = 'https://api.ebay.com/ws/api.dll';
  const version = '1271';
  const siteId = '0'; // US

  console.log('=== GetMyeBaySelling API 상세 테스트 ===\n');
  console.log('📋 헤더 정보:');
  console.log('  X-EBAY-API-COMPATIBILITY-LEVEL:', version);
  console.log('  X-EBAY-API-DEV-NAME:', devId);
  console.log('  X-EBAY-API-APP-NAME:', appId);
  console.log('  X-EBAY-API-CERT-NAME:', certId.substring(0, 20) + '...');
  console.log('  X-EBAY-API-CALL-NAME: GetMyeBaySelling');
  console.log('  X-EBAY-API-SITEID:', siteId);
  console.log('  X-EBAY-API-IAF-TOKEN:', userToken.substring(0, 50) + '...\n');

  const headers = {
    'X-EBAY-API-COMPATIBILITY-LEVEL': version,
    'X-EBAY-API-DEV-NAME': devId,
    'X-EBAY-API-APP-NAME': appId,
    'X-EBAY-API-CERT-NAME': certId,
    'X-EBAY-API-CALL-NAME': 'GetMyeBaySelling',
    'X-EBAY-API-SITEID': siteId,
    'X-EBAY-API-IAF-TOKEN': userToken,  // OAuth 토큰 (Bearer 아님!)
    'Content-Type': 'text/xml'
  };

  const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <DetailLevel>ReturnAll</DetailLevel>
  <ActiveList>
    <Include>true</Include>
    <Pagination>
      <EntriesPerPage>200</EntriesPerPage>
      <PageNumber>1</PageNumber>
    </Pagination>
  </ActiveList>
  <ScheduledList>
    <Include>true</Include>
  </ScheduledList>
  <SoldList>
    <Include>true</Include>
  </SoldList>
  <UnsoldList>
    <Include>true</Include>
  </UnsoldList>
</GetMyeBaySellingRequest>`;

  console.log('📤 요청 XML:');
  console.log(xml);
  console.log('\n' + '='.repeat(80) + '\n');

  try {
    const response = await axios.post(apiUrl, xml, { headers });

    console.log('✅ API 호출 성공!\n');
    console.log('📥 응답 XML (전문):');
    console.log('='.repeat(80));
    console.log(response.data);
    console.log('='.repeat(80));

    // XML을 파일로 저장
    const filename = `ebay-response-${Date.now()}.xml`;
    fs.writeFileSync(filename, response.data);
    console.log(`\n💾 응답 XML이 ${filename} 파일로 저장되었습니다.`);

    // 간단한 파싱 (ItemArray 찾기)
    const activeMatch = response.data.match(/<ActiveList>([\s\S]*?)<\/ActiveList>/);
    if (activeMatch) {
      const itemCount = (activeMatch[1].match(/<Item>/g) || []).length;
      console.log(`\n📦 ActiveList에서 찾은 Item 개수: ${itemCount}개`);
    }

    const scheduledMatch = response.data.match(/<ScheduledList>([\s\S]*?)<\/ScheduledList>/);
    if (scheduledMatch) {
      const itemCount = (scheduledMatch[1].match(/<Item>/g) || []).length;
      console.log(`📦 ScheduledList에서 찾은 Item 개수: ${itemCount}개`);
    }

    const soldMatch = response.data.match(/<SoldList>([\s\S]*?)<\/SoldList>/);
    if (soldMatch) {
      const itemCount = (soldMatch[1].match(/<Item>/g) || []).length;
      console.log(`📦 SoldList에서 찾은 Item 개수: ${itemCount}개`);
    }

    const unsoldMatch = response.data.match(/<UnsoldList>([\s\S]*?)<\/UnsoldList>/);
    if (unsoldMatch) {
      const itemCount = (unsoldMatch[1].match(/<Item>/g) || []).length;
      console.log(`📦 UnsoldList에서 찾은 Item 개수: ${itemCount}개`);
    }

    // Ack 확인
    const ackMatch = response.data.match(/<Ack>(.*?)<\/Ack>/);
    if (ackMatch) {
      console.log(`\n✅ Ack: ${ackMatch[1]}`);
    }

    // 에러 확인
    const errorMatch = response.data.match(/<Errors>([\s\S]*?)<\/Errors>/);
    if (errorMatch) {
      console.log('\n❌ 에러 발견:');
      const shortMsg = errorMatch[1].match(/<ShortMessage>(.*?)<\/ShortMessage>/)?.[1];
      const longMsg = errorMatch[1].match(/<LongMessage>(.*?)<\/LongMessage>/)?.[1];
      console.log('  ShortMessage:', shortMsg);
      console.log('  LongMessage:', longMsg);
    }

    return response.data;

  } catch (error) {
    console.error('❌ API 호출 실패:', error.message);
    if (error.response) {
      console.log('\n응답 상태:', error.response.status);
      console.log('응답 데이터:', error.response.data);
    }
    return null;
  }
}

testGetMyeBaySelling();
