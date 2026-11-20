import { Router } from 'express'
import { requireAuth } from './auth.js'
import { ActivityLog, PageView, PageVisitor, Route, RouteRecommendation, RouteStop, Stop, logActivity } from './models.js'

const TIPE = new Set(['biskita', 'angkot'])
const TIPE_TARIF = new Set(['flat', 'jarak'])
const STATUS = new Set(['aktif', 'nonaktif'])
const FARE = { biskita: 'Rp 4.000', angkot: 'Rp 5.000-7.000' }

const bad = (message) => Object.assign(new Error(message), { status: 400 })
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max)
const coordPair = (p) => Array.isArray(p) && p.length === 2 && p.every((n) => Number.isFinite(Number(n)))
    && Math.abs(Number(p[0])) <= 90 && Math.abs(Number(p[1])) <= 180

function cleanPaths(input) {
    if (input == null) return []
    if (!Array.isArray(input) || input.length > 50) throw bad('pathGeoJSON harus berupa array maksimal 50 segmen.')
    return input.map((line) => {
        if (!Array.isArray(line) || line.length < 2 || line.length > 50000) throw bad('Setiap segmen jalur harus punya 2–50000 titik.')
        return line.map((p) => {
            if (!coordPair(p)) throw bad('Koordinat jalur tidak valid.')
            return [Number(p[0]), Number(p[1])]
        })
    })
}

export function cleanStops(input) {
    if (input == null) return []
    if (!Array.isArray(input) || input.length > 500) throw bad('stops harus berupa array maksimal 500 titik.')
    return input.map((s, i) => {
        if (!s || !coordPair(s.pos)) throw bad(`Koordinat halte ke-${i + 1} tidak valid.`)
        return { pos: [Number(s.pos[0]), Number(s.pos[1])], name: str(s.name, 120) || `Halte ${i + 1}` }
    })
}

export function sanitizeRoute(body, kind) {
    const tipe = str(body?.tipe || kind, 20)
    if (!TIPE.has(tipe)) throw bad('tipe harus "biskita" atau "angkot".')
    const kodeRute = str(body?.kodeRute, 30)
    const asal = str(body?.asal, 120)
    if (!kodeRute) throw bad('Kode trayek wajib diisi.')
    if (!asal) throw bad('Titik awal wajib diisi.')
    return {
        tipe,
        kodeRute,
        namaRute: str(body?.namaRute, 200),
        asal,
        tujuan: str(body?.tujuan, 120),
        viaDeskripsi: str(body?.viaDeskripsi, 200),
        tarif: str(body?.tarif, 40) || FARE[tipe],
        tipeTarif: TIPE_TARIF.has(body?.tipeTarif) ? body.tipeTarif : 'flat',
        intervalMenit: Math.min(600, Math.max(0, Number(body?.intervalMenit) || 0)),
        jamOperasional: { buka: str(body?.jamOperasional?.buka, 5), tutup: str(body?.jamOperasional?.tutup, 5) },
        integrasi: (Array.isArray(body?.integrasi) ? body.integrasi : []).slice(0, 30).map((s) => str(s, 60)).filter(Boolean),
        status: STATUS.has(body?.status) ? body.status : 'aktif',
        color: /^#[0-9a-f]{6}$/i.test(body?.color || '') ? body.color : null,
        markerColor: /^#[0-9a-f]{6}$/i.test(body?.markerColor || '') ? body.markerColor : null,
        pathGeoJSON: cleanPaths(body?.pathGeoJSON),
    }
}

const routeSnapshot = (doc) => ({
    kodeRute: doc.kodeRute, namaRute: doc.namaRute, asal: doc.asal, tujuan: doc.tujuan,
    viaDeskripsi: doc.viaDeskripsi, tarif: doc.tarif, tipeTarif: doc.tipeTarif,
    intervalMenit: doc.intervalMenit, jamOperasional: doc.jamOperasional, integrasi: doc.integrasi,
    status: doc.status, halte: doc.halte ?? undefined, panjangJalur: doc.pathGeoJSON?.length ?? 0,
})

async function refreshTransitFlags() {
    const grouped = await RouteStop.aggregate([{ $group: { _id: '$stopId', routes: { $addToSet: '$routeId' } } }])
    const transitIds = grouped.filter((g) => g.routes.length > 1).map((g) => g._id)
    await Stop.updateMany({ _id: { $in: transitIds } }, { $set: { tipe: 'transit' } })
    await Stop.updateMany({ _id: { $nin: transitIds } }, { $set: { tipe: 'halte' } })
    await RouteStop.updateMany({ stopId: { $in: transitIds } }, { $set: { isTransitPoint: true } })
    await RouteStop.updateMany({ stopId: { $nin: transitIds } }, { $set: { isTransitPoint: false } })
}

async function syncRouteStops(route, stops) {
    await RouteStop.deleteMany({ routeId: route._id })
    if (!stops.length) return refreshTransitFlags()
    const pool = await Stop.find({})
    const same = (a, b) => Math.abs(a[0] - b[0]) < 0.0003 && Math.abs(a[1] - b[1]) < 0.0003
    const links = []
    for (let i = 0; i < stops.length; i++) {
        const { pos, name } = stops[i]
        const coordinates = [pos[1], pos[0]]
        let stop = pool.find((s) => s.nama === name && same(s.location.coordinates, coordinates))
        if (!stop) {
            stop = await Stop.create({ nama: name, location: { type: 'Point', coordinates } })
            pool.push(stop)
        }
        links.push({ routeId: route._id, stopId: stop._id, urutan: i + 1 })
    }
    await RouteStop.insertMany(links)
    await refreshTransitFlags()
}

async function routeWithStops(id) {
    const route = await Route.findById(id).lean()
    if (!route) return null
    const links = await RouteStop.find({ routeId: id }).sort({ urutan: 1 }).populate('stopId').lean()
    return {
        ...route,
        stops: links.filter((l) => l.stopId).map((l) => ({
            _id: l.stopId._id, nama: l.stopId.nama, tipe: l.stopId.tipe, location: l.stopId.location,
            alamat: l.stopId.alamat, fasilitas: l.stopId.fasilitas,
            urutan: l.urutan, isTransitPoint: l.isTransitPoint,
        })),
    }
}

export const apiRouter = Router()

/* ── Publik: dipakai peta & pencarian rute di frontend ───────────────── */

apiRouter.get('/public/routes', async (_request, response) => {
    const routes = await Route.find({ status: 'aktif' }).sort({ tipe: 1, kodeRute: 1 }).lean()
    const links = await RouteStop.find({ routeId: { $in: routes.map((r) => r._id) } })
        .sort({ urutan: 1 }).populate('stopId').lean()
    const byRoute = new Map()
    for (const l of links) {
        if (!l.stopId) continue
        if (!byRoute.has(String(l.routeId))) byRoute.set(String(l.routeId), [])
        byRoute.get(String(l.routeId)).push({
            nama: l.stopId.nama, tipe: l.stopId.tipe, location: l.stopId.location,
            urutan: l.urutan, isTransitPoint: l.isTransitPoint,
        })
    }
    const withStops = routes.map((r) => ({ ...r, stops: byRoute.get(String(r._id)) || [] }))
    response.json({
        biskita: withStops.filter((r) => r.tipe === 'biskita'),
        angkot: withStops.filter((r) => r.tipe === 'angkot'),
    })
})

apiRouter.post('/public/route-recommendations', async (request, response) => {
    const { origin, destination, suggestedRoutes, isMultimodal } = request.body || {}
    if (!coordPair(origin) || !coordPair(destination)) {
        return response.status(400).json({ ok: false, message: 'origin dan destination harus [lat, lng].' })
    }
    await RouteRecommendation.create({
        origin: [Number(origin[0]), Number(origin[1])],
        destination: [Number(destination[0]), Number(destination[1])],
        suggestedRoutes: (Array.isArray(suggestedRoutes) ? suggestedRoutes : []).slice(0, 20).map((s) => ({
            kodeRute: str(s?.kodeRute, 30), asal: str(s?.asal, 120), tujuan: str(s?.tujuan, 120),
            tarif: str(s?.tarif, 40), minutes: Math.min(1440, Math.max(0, Number(s?.minutes) || 0)),
        })),
        isMultimodal: Boolean(isMultimodal),
    })
    response.status(201).json({ ok: true })
})

apiRouter.post('/public/page-view', async (_request, response) => {
    const date = new Date().toISOString().slice(0, 10)
    await PageView.findOneAndUpdate({ date }, { $inc: { count: 1 } }, { upsert: true })
    response.status(201).json({ ok: true })
})

/* Catat pengunjung unik harian. `vid` hanya ID acak dari cookie yang dibuat
   setelah pengguna menyetujui; tidak ada data pribadi yang dikirim/disimpan. */
apiRouter.post('/public/visitor', async (request, response) => {
    const vid = str(request.body?.vid, 64)
    if (!/^[A-Za-z0-9-]{8,64}$/.test(vid)) {
        return response.status(400).json({ ok: false, message: 'ID pengunjung tidak valid.' })
    }
    const date = new Date().toISOString().slice(0, 10)
    try {
        await PageVisitor.updateOne({ date, vid }, { $setOnInsert: { date, vid } }, { upsert: true })
    } catch (error) {
        // Dua tab bisa mengirim ID yang sama bersamaan; duplikat bukan kegagalan.
        if (error?.code !== 11000) throw error
    }
    response.status(201).json({ ok: true })
})

/* Jalur jalan kaki mengikuti jalan asli. Provider utama: Valhalla pedestrian
   (FOSSGIS) karena memakai gang/jalur pejalan kaki/tangga dan snap lebih dekat;
   fallback: OSRM foot. Bila hasil provider pertama memutar tidak wajar dibanding
   jarak lurus, provider lain dicoba dan yang terpendek dipakai. Hasil di-cache
   di memori; bila semua layanan gagal balas ok:false agar frontend fallback
   ke garis lurus. */
const VALHALLA_API = 'https://valhalla1.openstreetmap.de/route'
const OSRM_FOOT_API = 'https://routing.openstreetmap.de/routed-foot/route/v1/foot'
const walkCache = new Map()

const walkKm = (a, b) => {
    const rad = Math.PI / 180
    const dLat = (b[0] - a[0]) * rad
    const dLng = (b[1] - a[1]) * rad
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLng / 2) ** 2
    return 6371 * 2 * Math.asin(Math.sqrt(h))
}

/* Shape Valhalla = encoded polyline presisi 1e6 → array [lat,lng]. */
function decodePolyline6(encoded) {
    const pts = []
    let i = 0, lat = 0, lng = 0
    while (i < encoded.length) {
        for (let axis = 0; axis < 2; axis++) {
            let shift = 0, result = 0, byte
            do {
                byte = encoded.charCodeAt(i++) - 63
                result |= (byte & 0x1f) << shift
                shift += 5
            } while (byte >= 0x20)
            const delta = result & 1 ? ~(result >> 1) : result >> 1
            if (axis === 0) lat += delta
            else lng += delta
        }
        pts.push([lat / 1e6, lng / 1e6])
    }
    return pts
}

/* Tolak geometri rusak / snap terlalu jauh dari titik yang diminta. */
const sanePts = (pts, from, to) => pts.length > 1 && pts.every((p) => coordPair(p))
    && walkKm(pts[0], from) < 2 && walkKm(pts[pts.length - 1], to) < 2

async function valhallaWalk(from, to) {
    const json = JSON.stringify({
        locations: [{ lat: from[0], lon: from[1] }, { lat: to[0], lon: to[1] }],
        costing: 'pedestrian',
        directions_options: { units: 'kilometers' },
    })
    const res = await fetch(`${VALHALLA_API}?json=${encodeURIComponent(json)}`, { signal: AbortSignal.timeout(8000) })
    const data = await res.json()
    const leg = data.trip?.legs?.[0]
    if (!leg?.shape) throw new Error('Rute jalan kaki tidak ditemukan.')
    const pts = decodePolyline6(leg.shape)
    if (!sanePts(pts, from, to)) throw new Error('Geometri jalan kaki tidak valid.')
    return { pts, km: data.trip.summary.length, min: data.trip.summary.time / 60 }
}

async function osrmWalk(from, to) {
    const url = `${OSRM_FOOT_API}/${from[1]},${from[0]};${to[1]},${to[0]}?overview=full&geometries=geojson`
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
    const data = await res.json()
    const r = data.routes?.[0]
    if (!r?.geometry?.coordinates?.length) throw new Error('Rute jalan kaki tidak ditemukan.')
    const pts = r.geometry.coordinates.map(([lng, lat]) => [lat, lng])
    if (!sanePts(pts, from, to)) throw new Error('Geometri jalan kaki tidak valid.')
    return { pts, km: r.distance / 1000, min: r.duration / 60 }
}

apiRouter.get('/public/walk-route', async (request, response) => {
    const point = (v) => {
        const [lat, lng] = String(v || '').split(',').map(Number)
        return coordPair([lat, lng]) ? [lat, lng] : null
    }
    const from = point(request.query.from)
    const to = point(request.query.to)
    if (!from || !to) return response.status(400).json({ ok: false, message: 'from dan to harus "lat,lng".' })
    const key = `${from[0].toFixed(5)},${from[1].toFixed(5)}|${to[0].toFixed(5)},${to[1].toFixed(5)}`
    if (walkCache.has(key)) return response.json(walkCache.get(key))
    // jalur kaki wajar bila <= 2,5x jarak lurus (atau +800 m untuk segmen pendek)
    const straight = walkKm(from, to)
    const limit = Math.max(2.5 * straight, straight + 0.8)
    let best = null
    for (const provider of [valhallaWalk, osrmWalk]) {
        const r = await provider(from, to).catch(() => null)
        if (!r) continue
        if (!best || r.km < best.km) best = r
        if (best.km <= limit) break
    }
    if (!best) return response.json({ ok: false })
    const out = {
        ok: true,
        // titik asal/tujuan eksak disambungkan ke ujung jalur layanan (yang di-snap ke jalan terdekat)
        pts: [from, ...best.pts, to],
        km: best.km,
        min: best.min,
    }
    if (walkCache.size > 500) walkCache.clear()
    walkCache.set(key, out)
    response.json(out)
})

/* ── Admin: CRUD rute, halte, dashboard, rekomendasi ─────────────────── */

apiRouter.use(requireAuth)

apiRouter.get('/routes', async (request, response) => {
    const filter = TIPE.has(request.query.tipe) ? { tipe: request.query.tipe } : {}
    const routes = await Route.find(filter).sort({ kodeRute: 1 }).lean()
    const counts = await RouteStop.aggregate([
        { $match: { routeId: { $in: routes.map((r) => r._id) } } },
        { $group: { _id: '$routeId', halte: { $sum: 1 } } },
    ])
    const halteOf = new Map(counts.map((c) => [String(c._id), c.halte]))
    response.json({ items: routes.map((r) => ({ ...r, halte: halteOf.get(String(r._id)) || 0 })) })
})

apiRouter.get('/routes/:id', async (request, response) => {
    const route = await routeWithStops(request.params.id).catch(() => null)
    if (!route) return response.status(404).json({ ok: false, message: 'Trayek tidak ditemukan.' })
    response.json(route)
})

apiRouter.post('/routes', async (request, response) => {
    const data = sanitizeRoute(request.body, request.body?.tipe)
    if (await Route.exists({ tipe: data.tipe, kodeRute: data.kodeRute })) {
        return response.status(409).json({ ok: false, message: `Kode ${data.kodeRute} sudah dipakai.` })
    }
    const route = await Route.create({ ...data, createdBy: request.admin._id, updatedAt: new Date() })
    await syncRouteStops(route, cleanStops(request.body?.stops))
    await logActivity({
        adminId: request.admin._id, action: 'create-route', targetCollection: 'routes',
        targetId: String(route._id), changes: { after: routeSnapshot(route) },
    })
    response.status(201).json({ ok: true, id: String(route._id) })
})

apiRouter.put('/routes/:id', async (request, response) => {
    const route = await Route.findById(request.params.id)
    if (!route) return response.status(404).json({ ok: false, message: 'Trayek tidak ditemukan.' })
    const before = routeSnapshot(route)
    const data = sanitizeRoute({ ...request.body, tipe: request.body?.tipe || route.tipe }, route.tipe)
    Object.assign(route, data, { updatedAt: new Date() })
    await route.save()
    await syncRouteStops(route, cleanStops(request.body?.stops))
    await logActivity({
        adminId: request.admin._id, action: 'update-route', targetCollection: 'routes',
        targetId: String(route._id), changes: { before, after: routeSnapshot(route) },
    })
    response.json({ ok: true })
})

apiRouter.delete('/routes/:id', async (request, response) => {
    const route = await Route.findById(request.params.id)
    if (!route) return response.status(404).json({ ok: false, message: 'Trayek tidak ditemukan.' })
    const before = routeSnapshot(route)
    await RouteStop.deleteMany({ routeId: route._id })
    await route.deleteOne()
    await Stop.deleteMany({ _id: { $nin: await RouteStop.distinct('stopId') } })
    await refreshTransitFlags()
    await logActivity({
        adminId: request.admin._id, action: 'delete-route', targetCollection: 'routes',
        targetId: String(before.kodeRute), changes: { before },
    })
    response.json({ ok: true })
})

apiRouter.get('/stops', async (request, response) => {
    const q = str(request.query.q, 100)
    const filter = q ? { nama: { $regex: q, $options: 'i' } } : {}
    const stops = await Stop.find(filter).sort({ nama: 1 }).limit(500).lean()
    const counts = await RouteStop.aggregate([{ $group: { _id: '$stopId', routes: { $sum: 1 } } }])
    const routesOf = new Map(counts.map((c) => [String(c._id), c.routes]))
    response.json({ items: stops.map((s) => ({ ...s, jumlahRute: routesOf.get(String(s._id)) || 0 })) })
})

apiRouter.get('/route-recommendations', async (_request, response) => {
    const items = await RouteRecommendation.find({}).sort({ createdAt: -1 }).limit(50).lean()
    response.json({ items })
})

apiRouter.get('/dashboard', async (request, response) => {
    const [biskita, angkot] = await Promise.all([
        Route.countDocuments({ tipe: 'biskita' }),
        Route.countDocuments({ tipe: 'angkot' }),
    ])
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000)
    const baru = await Route.aggregate([
        { $match: { createdAt: { $gte: since } } },
        { $group: { _id: '$tipe', n: { $sum: 1 } } },
    ])
    const baruOf = new Map(baru.map((b) => [b._id, b.n]))

    // Tarif dashboard diambil dari data routes di database, bukan konstanta.
    const fareAgg = await Route.aggregate([
        { $match: { tarif: { $ne: '' } } },
        { $group: { _id: '$tipe', fares: { $addToSet: '$tarif' } } },
    ])
    const fareOf = new Map(fareAgg.map((f) => [f._id, f.fares.sort().join(', ')]))

    // Satu periode aktif + satu periode sebelumnya untuk delta. Semua titik
    // memakai tanggal nyata; hari tanpa data tetap muncul dengan nilai nol.
    const RANGE_DAYS = { '7d': 7, '1m': 30, '6m': 182, '1y': 365 }
    const range = Object.hasOwn(RANGE_DAYS, request.query.range) ? request.query.range : '7d'
    const days = RANGE_DAYS[range]
    const DAY_MS = 24 * 3600 * 1000
    const dayKey = (t) => new Date(t).toISOString().slice(0, 10)
    const now = Date.now()
    const keys = Array.from({ length: days * 2 }, (_, i) => dayKey(now - (days * 2 - 1 - i) * DAY_MS))
    const lastDay = keys[keys.length - 1]
    const views = await PageView.find({ date: { $gte: keys[0], $lte: lastDay } }).lean()
    const countOf = new Map(views.map((v) => [v.date, v.count]))
    const lastKeys = keys.slice(days)
    const prevKeys = keys.slice(0, days)
    const totalOf = (arr) => arr.reduce((sum, key) => sum + (countOf.get(key) || 0), 0)
    // Grafik memakai unik harian. Total kartu memakai himpunan ID selama periode,
    // sehingga orang yang datang pada beberapa hari tidak dihitung berulang.
    const visitorAgg = await PageVisitor.aggregate([
        { $match: { date: { $gte: keys[0], $lte: lastDay } } },
        { $group: { _id: '$date', vids: { $addToSet: '$vid' } } },
    ])
    const uniqIdsOf = new Map(visitorAgg.map((v) => [v._id, v.vids]))
    const uniqSetOf = (arr) => new Set(arr.flatMap((key) => uniqIdsOf.get(key) || []))

    const series = lastKeys.map((key) => ({
        date: key,
        visits: countOf.get(key) || 0,
        unique: uniqIdsOf.get(key)?.length || 0,
    }))
    const prevTotal = totalOf(prevKeys)
    const visits = {
        total: totalOf(lastKeys),
        delta: prevTotal ? Math.round(((totalOf(lastKeys) - prevTotal) / prevTotal) * 100) : 0,
    }
    const uniqueNow = uniqSetOf(lastKeys).size
    const uniquePrev = uniqSetOf(prevKeys).size
    const unique = {
        total: uniqueNow,
        delta: uniquePrev ? Math.round(((uniqueNow - uniquePrev) / uniquePrev) * 100) : 0,
    }

    const logs = await ActivityLog.find({ targetCollection: 'routes' }).sort({ timestamp: -1 }).limit(4).lean()
    const TYPE = { 'create-route': 'Penambahan Rute', 'update-route': 'Perubahan Rute', 'delete-route': 'Penghapusan Rute' }
    const history = logs.map((l) => {
        const r = l.changes?.after || l.changes?.before || {}
        return {
            title: r.namaRute ? `${r.kodeRute} — ${r.namaRute}` : String(l.targetId || r.kodeRute || 'Rute'),
            type: TYPE[l.action] || 'Perubahan Rute',
            note: `${r.asal || ''}${r.tujuan ? ` → ${r.tujuan}` : ''}${r.viaDeskripsi ? ` (via ${r.viaDeskripsi})` : ''}` || 'Data rute diperbarui',
        }
    })

    response.json({
        biskita: { total: biskita, baru: baruOf.get('biskita') || 0, tarif: fareOf.get('biskita') || '—' },
        angkot: { total: angkot, baru: baruOf.get('angkot') || 0, tarif: fareOf.get('angkot') || '—' },
        visits,
        unique,
        range,
        series,
        history,
    })
})

/* Notifikasi admin: hanya tiga aksi tulis trayek yang dicatat. */
const NOTIF = {
    'create-route': { kind: 'create', label: 'Rute ditambahkan' },
    'update-route': { kind: 'update', label: 'Rute diperbarui' },
    'delete-route': { kind: 'delete', label: 'Rute dihapus' },
}

apiRouter.get('/notifications', async (request, response) => {
    const limit = Math.min(Math.max(Number(request.query.limit) || 12, 1), 50)
    const logs = await ActivityLog.find({ action: { $in: Object.keys(NOTIF) } })
        .sort({ timestamp: -1 })
        .limit(limit)
        .populate('adminId', 'nama username')
        .lean()
    const items = logs.map((log) => {
        const snap = log.changes?.after || log.changes?.before || {}
        const kode = snap.kodeRute || log.targetId || ''
        return {
            id: String(log._id),
            kind: NOTIF[log.action].kind,
            label: NOTIF[log.action].label,
            route: snap.namaRute ? `${kode} — ${snap.namaRute}` : String(kode || 'Rute'),
            note: [snap.asal, snap.tujuan].filter(Boolean).join(' → '),
            actor: log.adminId?.nama || log.adminId?.username || 'Admin',
            at: log.timestamp,
        }
    })
    response.json({ items })
})
