/* Seed database dari file GeoJSON di data/rute/.
   Jalankan: npm run seed  (butuh MONGODB_URI di .env)
   Menghapus isi koleksi routes/stops/route_stops lalu mengisinya ulang. */
import bcrypt from 'bcryptjs'
import dotenv from 'dotenv'
import fs from 'node:fs/promises'
import mongoose from 'mongoose'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectDatabase } from './db.js'
import { Admin, Route, RouteStop, Stop } from './models.js'

dotenv.config()

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'rute')
const FILES = { biskita: 'biskita-bogor-K1K2K5.geojson', angkot: 'angkot-kota-kabupaten-bogor.geojson' }
const FARE = { biskita: 'Rp 4.000', angkot: 'Rp 5.000-7.000' }

const load = async (file) => JSON.parse(await fs.readFile(path.join(DIR, file), 'utf8'))

function refFromName(name, fid) {
    const pre = name.match(/^([A-Z]+\d+[A-Z]?)\s*:/)
    if (pre) return pre[1]
    const t = name.match(/^Trayek\s+(\d+\w*)/i)
    if (t) return t[1]
    const k = name.match(/Kor\s*(\d+)/i)
    if (k) return `Kor ${k[1]}`
    if (/^\d+\w*$/.test(name)) return name
    return `#${fid ?? '?'}`
}

function splitTitle(name, p) {
    if (p.from && p.to) return [p.from, p.to]
    let s = name.replace(/^[A-Z]+\d+[A-Z]?\s*:\s*/, '').replace(/\s*\(via[^)]*\)/i, '').replace(/\s+PP$/i, '')
    const m = s.match(/\((.+)\)/)
    if (m && /[-–—]/.test(m[1])) s = m[1]
    const t = s.split(/\s*[–—]\s*|\s+-\s+|-(?=[A-Z])/).map((x) => x.trim()).filter(Boolean)
    return t.length >= 2 ? [t[0], t[t.length - 1]] : [s, '']
}

function groupRoutes(fc, kind, exclude = new Set()) {
    const groups = new Map()
    for (const f of fc.features) {
        const g = f.geometry
        const p = f.properties || {}
        if (!g || !/LineString$/.test(g.type)) continue
        const name = String(p.name ?? p.Nama ?? '').trim()
        const ref = String(p.ref ?? refFromName(name, p.FID))
        if (exclude.has(ref)) continue
        const [from, to] = splitTitle(name, p)
        const key = kind === 'biskita' ? ref : p.Nama ? name : p.from && p.to ? `${ref}|${[p.from, p.to].sort().join('>')}` : `${ref}|${name}`
        const lines = g.type === 'LineString' ? [g.coordinates] : g.coordinates
        if (!groups.has(key)) {
            groups.set(key, {
                ref, name, from, to, via: p.via || '', srcColor: p.color || p.stroke || p.colour || null, parts: [],
            })
        }
        groups.get(key).parts.push(...lines.map((l) => l.map((c) => [c[1], c[0]])).filter((x) => x.length > 1))
    }
    return [...groups.values()]
}

function collectStops(fc, routes) {
    const byRef = new Map(routes.map((r) => [r.ref, r]))
    const placed = []
    for (const f of fc.features) {
        const g = f.geometry
        const p = f.properties || {}
        if (!g || g.type !== 'Point') continue
        const rel = Array.isArray(p['@relations']) ? p['@relations'].find((x) => x.role === 'stop' && x.reltags?.ref) : null
        let ref = null
        if (rel) {
            ref = String(rel.reltags.ref)
        } else if (p.type === 'halte') {
            ref = p.ref != null
                ? String(p.ref)
                : [...byRef.values()].find((r) => r.srcColor && r.srcColor.toLowerCase() === String(p['marker-color'] || '').toLowerCase())?.ref ?? null
        }
        if (!ref || !byRef.has(ref)) continue
        placed.push({ ref, pos: [g.coordinates[1], g.coordinates[0]], name: String(p.name || p.title || '').trim() })
    }
    return placed
}

async function seed() {
    await connectDatabase()
    console.log('Terhubung ke MongoDB. Mengosongkan koleksi routes/stops/route_stops…')
    await Promise.all([Route.deleteMany({}), Stop.deleteMany({}), RouteStop.deleteMany({})])

    const [fcBis, fcAngkot] = await Promise.all([load(FILES.biskita), load(FILES.angkot)])
    const biskita = groupRoutes(fcBis, 'biskita')
    const angkot = groupRoutes(fcAngkot, 'angkot', new Set(biskita.map((r) => r.ref)))

    const toDoc = (r, tipe) => ({
        tipe,
        kodeRute: r.ref,
        namaRute: r.name || `${r.from}–${r.to}`,
        asal: r.from || r.ref,
        tujuan: r.to || '',
        viaDeskripsi: r.via,
        pathGeoJSON: r.parts,
        tarif: FARE[tipe],
        tipeTarif: tipe === 'biskita' ? 'flat' : 'jarak',
        intervalMenit: tipe === 'biskita' ? 15 : 10,
        jamOperasional: tipe === 'biskita' ? { buka: '05:00', tutup: '21:00' } : { buka: '05:30', tutup: '20:00' },
        integrasi: [],
        status: 'aktif',
        color: r.srcColor,
    })
    const docs = [...biskita.map((r) => toDoc(r, 'biskita')), ...angkot.map((r) => toDoc(r, 'angkot'))]

    const inserted = await Route.insertMany(docs)
    const routeIdOf = new Map(inserted.map((d) => [d.kodeRute, d._id]))
    console.log(`${inserted.length} rute dimasukkan (${biskita.length} biskita, ${angkot.length} angkot).`)

    const placed = collectStops(fcBis, biskita)
    const stopIdOf = new Map()
    const stopDocs = []
    const urutan = new Map()
    const links = []
    const routesOfStop = []
    for (const s of placed) {
        const routeId = routeIdOf.get(s.ref)
        if (!routeId) continue
        const n = (urutan.get(s.ref) || 0) + 1
        urutan.set(s.ref, n)
        const name = s.name || `Halte ${n}`
        const key = `${name}|${s.pos[0].toFixed(5)},${s.pos[1].toFixed(5)}`
        let si = stopIdOf.get(key)
        if (si == null) {
            si = stopDocs.length
            stopIdOf.set(key, si)
            stopDocs.push({ nama: name, tipe: 'halte', location: { type: 'Point', coordinates: [s.pos[1], s.pos[0]] } })
            routesOfStop.push(new Set())
        }
        links.push({ routeId, stopId: null, urutan: n, stopIndex: si })
        routesOfStop[si].add(String(routeId))
    }
    const stopsInserted = await Stop.insertMany(stopDocs)
    for (const l of links) l.stopId = stopsInserted[l.stopIndex]._id
    const transitIds = new Set(stopsInserted.filter((_, i) => routesOfStop[i].size > 1).map((s) => String(s._id)))
    await RouteStop.insertMany(links.map(({ stopIndex, ...l }) => ({ ...l, isTransitPoint: transitIds.has(String(l.stopId)) })))
    if (transitIds.size) {
        await Stop.updateMany({ _id: { $in: [...transitIds] } }, { $set: { tipe: 'transit' } })
    }
    console.log(`${stopsInserted.length} halte & ${links.length} relasi route_stops dimasukkan (${transitIds.size} titik transit).`)

    const adminUsername = process.env.SEED_ADMIN_USERNAME || 'transgiscihuy'
    const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'transgisniwok,sstt'
    if (!(await Admin.findOne({ username: adminUsername }))) {
        await Admin.create({
            username: adminUsername,
            password: await bcrypt.hash(adminPassword, 10),
            nama: 'Admin Dishub Bogor',
            role: 'Pengelola Trayek Kota',
        })
        console.log(`Admin awal dibuat: ${adminUsername} / ${adminPassword} (ganti segera).`)
    } else {
        console.log(`Admin ${adminUsername} sudah ada, dilewati.`)
    }

    // Kunjungan portal (page_views) tidak di-seed: angka diisi oleh kunjungan nyata
    // melalui endpoint POST /api/public/page-view.

    console.log('Seed selesai.')
    await mongoose.disconnect()
}

seed().catch((error) => {
    console.error('Seed gagal:', error.message)
    process.exit(1)
})
