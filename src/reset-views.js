/* Kosongkan koleksi page_views (hitungan kunjungan) dan page_visitors
   (ID pengunjung unik). Dipakai untuk membuang sisa data seed lama yang dummy.
   Lihat isi tanpa menghapus:  npm run views:reset
   Kosongkan:                  npm run views:reset -- --yes */
import dotenv from 'dotenv'
import mongoose from 'mongoose'
import { connectDatabase } from './db.js'
import { PageView, PageVisitor } from './models.js'

dotenv.config()

await connectDatabase()
const rows = await PageView.find({}).sort({ date: 1 }).lean()
const total = rows.reduce((sum, r) => sum + (r.count || 0), 0)
const visitorRows = await PageVisitor.countDocuments({})

console.log(`page_views: ${rows.length} baris, ${total} kunjungan.`)
console.log(`page_visitors: ${visitorRows} baris ID pengunjung unik.`)

if (!rows.length && !visitorRows) {
    console.log('Kedua koleksi sudah kosong — tidak ada yang perlu dihapus.')
} else {
    if (rows.length) for (const r of rows) console.log(`  ${r.date}: ${r.count}`)
    if (process.argv.includes('--yes')) {
        await Promise.all([PageView.deleteMany({}), PageVisitor.deleteMany({})])
        console.log('page_views & page_visitors dikosongkan. Data baru tercatat mulai sekarang.')
    } else {
        console.log('Tidak ada yang dihapus. Jalankan ulang dengan --yes untuk mengosongkan.')
    }
}

await mongoose.disconnect()