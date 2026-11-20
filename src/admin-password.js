/* Ganti / buat kata sandi admin.
   Contoh: npm run admin:password -- admin sandiBaru123 */
import bcrypt from 'bcryptjs'
import dotenv from 'dotenv'
import mongoose from 'mongoose'
import { connectDatabase } from './db.js'
import { Admin } from './models.js'

dotenv.config()

const [username, password, nama] = process.argv.slice(2)
if (!username || !password || password.length < 6) {
    console.error('Pemakaian: npm run admin:password -- <username> <password-min-6> [nama]')
    process.exit(1)
}

await connectDatabase()
const hash = await bcrypt.hash(password, 10)
const admin = await Admin.findOneAndUpdate(
    { username },
    { $set: { password: hash, updatedAt: new Date() }, $setOnInsert: { nama: nama || username, role: 'admin' } },
    { new: true, upsert: true },
)
console.log(`Kata sandi untuk admin "${admin.username}" diperbarui.`)
await mongoose.disconnect()
