-- SYNTHETIC demo data for LOCAL development only. No real customers, briefs or outputs.
-- Operators are NOT seeded here (no passwords in a public repo): use `npm run operator:sql`.
INSERT OR IGNORE INTO customers (id, external_ref, display_name, consent_at, consent_terms_version, created_at) VALUES
  ('c0000000-0000-4000-8000-000000000001', 'demo_cust_kopi_0001', 'Demo: Kopi Senja (synthetic)', '2026-10-01T08:00:00Z', 'terms-2026-10', '2026-10-01T08:00:00Z'),
  ('c0000000-0000-4000-8000-000000000002', 'demo_cust_batik_0002', 'Demo: Batik Lestari (synthetic)', '2026-10-02T08:00:00Z', 'terms-2026-10', '2026-10-02T08:00:00Z'),
  ('c0000000-0000-4000-8000-000000000003', 'demo_cust_skin_0003', 'Demo: Glow Lab (synthetic)', '2026-10-03T08:00:00Z', 'terms-2026-10', '2026-10-03T08:00:00Z');

INSERT OR IGNORE INTO orders (id, public_ref, customer_id, service_code, token_version, created_at, updated_at) VALUES
  ('o0000000-0000-4000-8000-000000000001', 'EMB-DEMO1-AAAAA', 'c0000000-0000-4000-8000-000000000001', 'SCRIPT_PACK', 1, '2026-10-20T09:00:00Z', '2026-10-20T09:00:00Z'),
  ('o0000000-0000-4000-8000-000000000002', 'EMB-DEMO2-BBBBB', 'c0000000-0000-4000-8000-000000000002', 'PRODUCT_STORY', 1, '2026-10-21T09:00:00Z', '2026-10-21T09:00:00Z'),
  ('o0000000-0000-4000-8000-000000000003', 'EMB-DEMO3-CCCCC', 'c0000000-0000-4000-8000-000000000003', 'HOOK_CAPTION_PACK', 1, '2026-10-22T09:00:00Z', '2026-10-22T09:00:00Z');

INSERT OR IGNORE INTO briefs (id, order_id, objective, audience, product_facts, platforms, language, tone, cta, constraints, references_json, rights_confirmed, created_at, updated_at) VALUES
  ('b0000000-0000-4000-8000-000000000001', 'o0000000-0000-4000-8000-000000000001',
   'Promote a new cold brew bottle to office workers for weekday mornings.',
   'Office workers 22-35 in Jakarta who buy coffee on the way to work.',
   'Fictional product: 250 ml cold brew, arabica blend, no added sugar. (Synthetic demo facts.)',
   '["tiktok","instagram_reels"]', 'id', 'Santai, hangat', 'Pesan lewat link di bio', 'No health claims. No price mentions.', '[]', 1,
   '2026-10-20T09:00:00Z', '2026-10-20T09:00:00Z'),
  ('b0000000-0000-4000-8000-000000000002', 'o0000000-0000-4000-8000-000000000002',
   'Tell the story behind a handmade batik scarf collection.',
   'Women 25-45 interested in local craft and gifts.',
   'Fictional brand: hand-drawn batik tulis scarves, natural dyes. (Synthetic demo facts.)',
   '["instagram_reels"]', 'id', 'Elegan, bercerita', 'Kunjungi katalog', 'Do not claim UNESCO certification.', '[]', 1,
   '2026-10-21T09:00:00Z', '2026-10-21T09:00:00Z'),
  ('b0000000-0000-4000-8000-000000000003', 'o0000000-0000-4000-8000-000000000003',
   'Hooks and captions for a gentle face wash launch.',
   'Students and young professionals with sensitive skin.',
   'Fictional product: 100 ml gentle cleanser, fragrance-free. (Synthetic demo facts.)',
   '["tiktok"]', 'id', 'Ceria', 'Cek keranjang kuning', 'No medical or before/after claims.', '[]', 0,
   '2026-10-22T09:00:00Z', '2026-10-22T09:00:00Z');

INSERT OR IGNORE INTO jobs (id, order_id, state, priority, created_at, updated_at) VALUES
  ('j0000000-0000-4000-8000-000000000001', 'o0000000-0000-4000-8000-000000000001', 'SUBMITTED', 'NORMAL', '2026-10-20T09:00:00Z', '2026-10-20T09:00:00Z'),
  ('j0000000-0000-4000-8000-000000000002', 'o0000000-0000-4000-8000-000000000002', 'SUBMITTED', 'HIGH', '2026-10-21T09:00:00Z', '2026-10-21T09:00:00Z'),
  ('j0000000-0000-4000-8000-000000000003', 'o0000000-0000-4000-8000-000000000003', 'SUBMITTED', 'NORMAL', '2026-10-22T09:00:00Z', '2026-10-22T09:00:00Z');

INSERT OR IGNORE INTO job_state_history (id, job_id, from_state, to_state, actor_type, actor_id, reason, correlation_id, created_at) VALUES
  ('h0000000-0000-4000-8000-000000000001', 'j0000000-0000-4000-8000-000000000001', NULL, 'SUBMITTED', 'SYSTEM', 'seed', 'synthetic seed', 'seed-0001', '2026-10-20T09:00:00Z'),
  ('h0000000-0000-4000-8000-000000000002', 'j0000000-0000-4000-8000-000000000002', NULL, 'SUBMITTED', 'SYSTEM', 'seed', 'synthetic seed', 'seed-0002', '2026-10-21T09:00:00Z'),
  ('h0000000-0000-4000-8000-000000000003', 'j0000000-0000-4000-8000-000000000003', NULL, 'SUBMITTED', 'SYSTEM', 'seed', 'synthetic seed', 'seed-0003', '2026-10-22T09:00:00Z');
