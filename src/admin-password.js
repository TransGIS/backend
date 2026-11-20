/* Ganti / buat kata sandi admin.
   Contoh:
     npm run admin:password -- admin sandiBaru123
     npm run admin:password -- transgiscihuy 'sandiBaru,123' "Nama Baru" --ganti admin

   --ganti <usernameLama> memindahkan akun lama ke username baru: dokumen admin
   yang sama (id tetap, riwayat aktivitas tetap terhubung) diubah username dan
   kata sandinya, sehingga username lama tidak lagi bisa login. */
import bcrypt from 'bcryptjs'
import dotenv from 'dotenv'
import mongoose from 'mongoose'
import { connectDatabase } from './db.js'
import { Admin } from './models.js'

dotenv.config()

const args = process.argv.slice(2)
const gantiIndex = args.indexOf('--ganti')
const usernameLama = gantiIndex >= 0 ? args[gantiIndex + 1] : ''
const positional = gantiIndex >= 0 ? [...args.slice(0, gantiIndex), ...args.slice(gantiIndex + 2)] : args
const [username, password, nama] = positional

if (!username || !password || password.length < 6) {
    console.error('Pemakaian: npm run admin:password -- <username> <password-min-6> [nama] [--ganti <usernameLama>]')
    process.exit(1)
}
if (gantiIndex >= 0 && !usernameLama) {
    console.error('--ganti membutuhkan username akun lama.')
    process.exit(1)
}

await connectDatabase()
const hash = await bcrypt.hash(password, 10)

if (usernameLama) {
    const lama = await Admin.findOne({ username: usernameLama })
    if (!lama) {
        console.error(`Akun "${usernameLama}" tidak ditemukan di database.`)
        await mongoose.disconnect()
        process.exit(1)
    }
    const bentrok = await Admin.findOne({ username })
    if (bentrok && String(bentrok._id) !== String(lama._id)) {
        console.error(`Username "${username}" sudah dipakai akun lain.`)
        await mongoose.disconnect()
        process.exit(1)
    }
    lama.username = username
    lama.password = hash
    lama.updatedAt = new Date()
    if (nama) lama.nama = nama
    await lama.save()
    console.log(`Akun "${usernameLama}" diganti menjadi "${username}" dan kata sandi diperbarui.`)
} else {
    const admin = await Admin.findOneAndUpdate(
        { username },
        { $set: { password: hash, updatedAt: new Date() }, $setOnInsert: { nama: nama || username, role: 'admin' } },
        { new: true, upsert: true },
    )
    console.log(`Kata sandi untuk admin "${admin.username}" diperbarui.`)
}

const daftar = await Admin.find({}).select('username')
console.log(`Akun admin terdaftar: ${daftar.map((a) => a.username).join(', ') || '(tidak ada)'}`)
await mongoose.disconnect()
