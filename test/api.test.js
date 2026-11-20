import assert from 'node:assert/strict'
import test from 'node:test'

process.env.MONGODB_URI = ''

test('sanitizeRoute menolak input tidak valid', async () => {
    const { cleanStops, sanitizeRoute } = await import('../src/routes.js')
    assert.throws(() => sanitizeRoute({}, undefined), /tipe/)
    assert.throws(() => sanitizeRoute({ tipe: 'biskita' }, undefined), /Kode trayek/)
    assert.throws(() => sanitizeRoute({ tipe: 'biskita', kodeRute: 'K1' }, undefined), /Titik awal/)
    assert.throws(() => sanitizeRoute({ tipe: 'biskita', kodeRute: 'K1', asal: 'A', pathGeoJSON: [[[1, 2], [3]]] }, undefined), /Koordinat/)
    assert.throws(() => cleanStops([{ pos: [1] }]), /halte/)
    assert.deepEqual(cleanStops([{ pos: [-6.6, 106.8] }]), [{ pos: [-6.6, 106.8], name: 'Halte 1' }])
})

test('sanitizeRoute merapikan input valid', async () => {
    const { sanitizeRoute } = await import('../src/routes.js')
    const ok = sanitizeRoute({
        tipe: 'angkot', kodeRute: ' 07 ', asal: 'Terminal', tujuan: 'Pasar', integrasi: ['KRL', ''],
        intervalMenit: '9999', status: 'hilang', color: 'bukan-warna', pathGeoJSON: [[[-6.6, 106.8], [-6.61, 106.81]]],
    }, undefined)
    assert.equal(ok.kodeRute, '07')
    assert.equal(ok.intervalMenit, 600)
    assert.equal(ok.status, 'aktif')
    assert.equal(ok.color, null)
    assert.deepEqual(ok.integrasi, ['KRL'])
    assert.equal(ok.tarif, 'Rp 5.000-7.000')
    assert.equal(ok.pathGeoJSON[0].length, 2)
})

test('tanpa MONGODB_URI endpoint membalas 503 dengan pesan jelas', async () => {
    const { default: app } = await import('../src/app.js')
    const server = app.listen(0)
    await new Promise((resolve) => server.once('listening', resolve))
    const base = `http://127.0.0.1:${server.address().port}`
    try {
        const health = await fetch(`${base}/api/health`)
        const healthBody = await health.json()
        assert.equal(health.status, 503)
        assert.match(healthBody.message, /MONGODB_URI/)

        const routes = await fetch(`${base}/api/routes`)
        assert.equal(routes.status, 503)

        const missing = await fetch(`${base}/api/tidak-ada`)
        assert.equal(missing.status, 503)
    } finally {
        server.close()
    }
})
