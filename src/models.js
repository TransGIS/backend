import mongoose from 'mongoose'

const timestamps = { createdAt: { type: Date, default: Date.now }, updatedAt: { type: Date, default: Date.now } }
// nama koleksi eksplisit agar sesuai skema: admins, routes, stops, route_stops, route_recommendations, activity_logs
const model = (name, collection, schema) => mongoose.model(name, schema, collection)

export const Admin = model('Admin', 'admins', new mongoose.Schema({
    username: { type: String, required: true, unique: true, trim: true },
    password: { type: String, required: true },
    nama: { type: String, required: true, trim: true },
    role: { type: String, default: 'admin' },
    email: { type: String, lowercase: true, trim: true },
    ...timestamps,
}))

export const Route = model('Route', 'routes', new mongoose.Schema({
    tipe: { type: String, enum: ['biskita', 'angkot'], required: true, index: true },
    kodeRute: { type: String, required: true, trim: true },
    namaRute: { type: String, default: '' },
    asal: { type: String, required: true, trim: true },
    tujuan: { type: String, default: '' },
    viaDeskripsi: { type: String, default: '' },
    pathGeoJSON: { type: [[[Number]]], default: [] }, // [[ [lat,lng], ... ], ...] segmen jalur
    tarif: { type: String, default: '' },
    tipeTarif: { type: String, enum: ['flat', 'jarak'], default: 'flat' },
    intervalMenit: { type: Number, default: 15 },
    jamOperasional: { buka: { type: String, default: '05:00' }, tutup: { type: String, default: '21:00' } },
    integrasi: { type: [String], default: [] },
    status: { type: String, enum: ['aktif', 'nonaktif'], default: 'aktif' },
    color: { type: String, default: null },
    markerColor: { type: String, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    ...timestamps,
}))
Route.schema.index({ tipe: 1, kodeRute: 1 })

export const Stop = model('Stop', 'stops', new mongoose.Schema({
    nama: { type: String, required: true, trim: true },
    tipe: { type: String, enum: ['halte', 'pangkalan', 'transit'], default: 'halte' },
    location: {
        type: { type: String, enum: ['Point'], default: 'Point' },
        coordinates: { type: [Number], required: true }, // [lng, lat]
    },
    alamat: { type: String, default: '' },
    fasilitas: { type: [String], default: [] },
    ...timestamps,
}))

export const RouteStop = model('RouteStop', 'route_stops', new mongoose.Schema({
    routeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Route', required: true, index: true },
    stopId: { type: mongoose.Schema.Types.ObjectId, ref: 'Stop', required: true, index: true },
    urutan: { type: Number, default: 0 },
    isTransitPoint: { type: Boolean, default: false },
}))

export const RouteRecommendation = model('RouteRecommendation', 'route_recommendations', new mongoose.Schema({
    origin: { type: [Number], required: true },      // [lat, lng]
    destination: { type: [Number], required: true }, // [lat, lng]
    suggestedRoutes: { type: [{ kodeRute: String, asal: String, tujuan: String, tarif: String, minutes: Number }], default: [] },
    isMultimodal: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
}))

export const ActivityLog = model('ActivityLog', 'activity_logs', new mongoose.Schema({
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    action: { type: String, required: true },
    targetCollection: { type: String, default: '' },
    targetId: { type: String, default: null },
    changes: { type: mongoose.Schema.Types.Mixed, default: null },
    timestamp: { type: Date, default: Date.now },
}))

export const PageView = model('PageView', 'page_views', new mongoose.Schema({
    date: { type: String, required: true, unique: true }, // YYYY-MM-DD
    count: { type: Number, default: 0 },
}))

/* Pengunjung unik per hari: satu baris = satu ID anonim (cookie) yang terlihat
   pada tanggal tersebut. Tidak menyimpan IP, user-agent, atau identitas lain. */
const pageVisitorSchema = new mongoose.Schema({
    date: { type: String, required: true }, // YYYY-MM-DD
    vid: { type: String, required: true },  // ID acak (UUID) dari cookie
})
pageVisitorSchema.index({ date: 1, vid: 1 }, { unique: true })
export const PageVisitor = model('PageVisitor', 'page_visitors', pageVisitorSchema)

export async function logActivity(entry) {
    try {
        await ActivityLog.create(entry)
    } catch {
        // logging tidak boleh menggagalkan request utama
    }
}
