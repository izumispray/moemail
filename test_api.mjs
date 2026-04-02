const API_KEY = 'mk_mHgWm5PYMTtxJDNhKHP7gKsmGYcS-Oq5';
const BASE = 'https://mail.mui.moe';

// Test: POST without body (should trigger JSON parse error in try-catch)
console.log('=== Test: POST /api/emails/subdomain (no body) ===');
const r1 = await fetch(`${BASE}/api/emails/subdomain`, {
  method: 'POST',
  headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' }
});
console.log('Status:', r1.status);
console.log('Body:', (await r1.text()).substring(0, 300));

// Test: POST with empty object (should hit "缺少基础域名参数" before findZoneId)
console.log('\n=== Test: POST with empty object ===');
const r2 = await fetch(`${BASE}/api/emails/subdomain`, {
  method: 'POST',
  headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify({})
});
console.log('Status:', r2.status);
console.log('Body:', (await r2.text()).substring(0, 300));

// Test: POST with moyii.de (crashes at findZoneId?)
console.log('\n=== Test: POST with moyii.de ===');
const r3 = await fetch(`${BASE}/api/emails/subdomain`, {
  method: 'POST',
  headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify({ domain: 'moyii.de', prefix: 'test1' })
});
console.log('Status:', r3.status);
console.log('Body:', (await r3.text()).substring(0, 500));
