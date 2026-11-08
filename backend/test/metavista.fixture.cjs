const order = (overrides = {}) => ({
  schemaVersion: 1, id: 'MV-999981', revision: 1,
  createdAt: '2026-10-29T10:00:00.000Z', updatedAt: '2026-10-29T10:00:00.000Z', status: 'pending',
  customer: { firstName: 'Test', lastName: 'Import', email: 'metavista-test@example.invalid', phone: '+34600000000' },
  delivery: { country: 'Spain', city: 'Madrid', zip: '28001', address: 'Test 1', method: 'std', tracking: null, shippingPending: false },
  pricing: { currency: 'EUR', subtotal: 72, discount: 0, shipping: 9.9, total: 81.9 },
  payment: { status: 'paid', paidAmount: 81.9, paidAt: '2026-10-29T10:00:00.000Z' },
  items: [{ id: 1, productId: 'classic', name: 'Classic print', spec: '30 × 40', qty: 1,
    unitPrice: 72, lineSubtotal: 72, lineTotal: 72, note: 'Keep edges', configuration: null, backText: null, files: [] }],
  ...overrides,
});
const config = (values = {}) => ({ get: (key, fallback) => values[key] ?? fallback });
module.exports = { order, config };
