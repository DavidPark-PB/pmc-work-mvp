'use strict';
/**
 * ebayBuildItemXml.test.js — _buildItemXml 이 ProductListingDetails 를 올바르게 emit 하는지 검증.
 *
 * 배경 (2026-08-30): Vinyl LP 등록 시 "The UPC field is missing" 로 반려.
 *   ItemSpecifics 에 UPC 넣어도 eBay 는 <ProductListingDetails><UPC> 태그를 별도 요구.
 *   이제 UPC 는 없어도 항상 "Does not apply" 자동 emit · EAN/ISBN 은 값 있을 때만 emit.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const EbayAPI = require('../../src/api/ebayAPI');

const api = new EbayAPI();

const base = {
  title: 'Test',
  description: 'd',
  price: 10,
  quantity: 1,
  sku: 'PMC-1',
  categoryId: '176985',
  conditionId: '1000',
  imageUrls: [],
  currency: 'USD',
};

test('UPC 없음 → <UPC>Does not apply</UPC> 자동 삽입', () => {
  const xml = api._buildItemXml({ ...base, itemSpecifics: { Brand: 'X' } });
  assert.match(xml, /<ProductListingDetails>[\s\S]*<UPC>Does not apply<\/UPC>[\s\S]*<\/ProductListingDetails>/);
});

test('UPC 있음 → 실제 값 emit · ItemSpecifics 에도 유지 (belt-and-suspenders)', () => {
  const xml = api._buildItemXml({ ...base, itemSpecifics: { UPC: '012345678905', Brand: 'X' } });
  assert.match(xml, /<UPC>012345678905<\/UPC>/);
  // ItemSpecifics 에도 유지
  assert.match(xml, /<Name>UPC<\/Name>\s*<Value>012345678905<\/Value>/);
});

test('UPC 키 대소문자 / 별칭 (case-insensitive)', () => {
  const xml1 = api._buildItemXml({ ...base, itemSpecifics: { upc: '111' } });
  assert.match(xml1, /<UPC>111<\/UPC>/);
  const xml2 = api._buildItemXml({ ...base, itemSpecifics: { 'Universal Product Code': '222' } });
  assert.match(xml2, /<UPC>222<\/UPC>/);
});

test('EAN 있음 → <EAN> emit · 없으면 태그 아예 없음 (Does not apply 강제 X)', () => {
  const xml1 = api._buildItemXml({ ...base, itemSpecifics: { EAN: '4001234567890' } });
  assert.match(xml1, /<EAN>4001234567890<\/EAN>/);
  const xml2 = api._buildItemXml({ ...base, itemSpecifics: { Brand: 'X' } });
  assert.doesNotMatch(xml2, /<EAN>/);
});

test('ISBN 있음 → <ISBN> emit · ISBN-13 별칭도 인식', () => {
  const xml1 = api._buildItemXml({ ...base, itemSpecifics: { ISBN: '9784065012345' } });
  assert.match(xml1, /<ISBN>9784065012345<\/ISBN>/);
  const xml2 = api._buildItemXml({ ...base, itemSpecifics: { 'ISBN-13': '9784065012345' } });
  assert.match(xml2, /<ISBN>9784065012345<\/ISBN>/);
});

test('itemSpecifics 자체가 비어도 <UPC>Does not apply</UPC> 는 emit', () => {
  const xml = api._buildItemXml({ ...base, itemSpecifics: {} });
  assert.match(xml, /<UPC>Does not apply<\/UPC>/);
});

test('UPC 값이 XML-unsafe 문자 포함해도 escape', () => {
  const xml = api._buildItemXml({ ...base, itemSpecifics: { UPC: '1&2<3' } });
  assert.match(xml, /<UPC>1&amp;2&lt;3<\/UPC>/);
});

test('ProductListingDetails 는 SellerProfiles 뒤 · ItemSpecifics 앞에 emit (eBay 스키마 순서)', () => {
  const xml = api._buildItemXml({ ...base, itemSpecifics: { Brand: 'X' } });
  const pldPos  = xml.indexOf('<ProductListingDetails>');
  const specPos = xml.indexOf('<ItemSpecifics>');
  const sellerPos = xml.indexOf('</SellerProfiles>');
  assert.ok(pldPos > sellerPos, 'ProductListingDetails 는 SellerProfiles 뒤에 와야 함');
  assert.ok(specPos > pldPos, 'ItemSpecifics 는 ProductListingDetails 뒤에 와야 함');
});
