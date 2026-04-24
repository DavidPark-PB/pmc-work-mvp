-- B2B 문서 분리: 인보이스 (INVOICE) vs 견적서 (QUOTE)
-- 견적서는 매출 집계 제외, 번호 접두사 Q-, 템플릿 타이틀 "QUOTATION".
-- 같은 테이블에서 분기 — doc_type 컬럼으로 필터.

alter table b2b_invoices
  add column if not exists doc_type varchar(20) not null default 'INVOICE';

create index if not exists b2b_invoices_doc_type_idx on b2b_invoices (doc_type);
