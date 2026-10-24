import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import pg from 'pg';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const { Pool } = pg;
const app = express();
const port = Number(process.env.PORT || 8080);
const secret = process.env.JWT_SECRET || '';
const uploadDir = path.resolve(process.env.UPLOAD_DIR || './uploads');
const maxMb = Math.max(1, Number(process.env.MAX_UPLOAD_MB || 12));
if (process.env.NODE_ENV === 'production' && secret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters in production');
fs.mkdirSync(uploadDir, { recursive: true });
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : undefined });
app.disable('x-powered-by');
app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));
app.use(cors({ origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map(s => s.trim()) : false }));
app.use(express.json({ limit: '100kb' }));
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '../../public');
app.use(express.static(publicDir));

const asyncRoute = fn => (req,res,next) => Promise.resolve(fn(req,res,next)).catch(next);
function auth(req,res,next){
  const h=req.headers.authorization||''; const token=h.startsWith('Bearer ')?h.slice(7):'';
  if(!token) return res.status(401).json({error:'AUTH_REQUIRED'});
  try { req.user=jwt.verify(token,secret); next(); } catch { return res.status(401).json({error:'INVALID_TOKEN'}); }
}
async function membership(eventId,userId){
  const r=await pool.query('SELECT role FROM event_members WHERE event_id=$1 AND user_id=$2',[eventId,userId]);
  return r.rows[0]||null;
}
async function logActivity(eventId,userId,action,details={}){
  await pool.query('INSERT INTO activity_log(event_id,user_id,action,details) VALUES($1,$2,$3,$4)',[eventId,userId,action,JSON.stringify(details)]);
}
const storage=multer.diskStorage({destination:uploadDir,filename:(req,file,cb)=>cb(null,crypto.randomUUID()+path.extname(file.originalname).toLowerCase().slice(0,10))});
const upload=multer({storage,limits:{fileSize:maxMb*1024*1024,files:1},fileFilter:(req,file,cb)=>{
  const ok=['image/jpeg','image/png','image/webp'].includes(file.mimetype);
  cb(ok?null:new Error('Hanya gambar JPEG, PNG, atau WebP yang diizinkan.'),ok);
}});

app.get('/api/health',(req,res)=>res.json({ok:true,service:'dicr-api',version:'0.5.0'}));
app.post('/api/auth/register',asyncRoute(async(req,res)=>{
  const {email,password,displayName,eventName}=req.body||{};
  if(typeof email!=='string'||!/^\S+@\S+\.\S+$/.test(email)||typeof password!=='string'||password.length<10||typeof displayName!=='string'||displayName.trim().length<2)
    return res.status(400).json({error:'INVALID_INPUT',message:'Email valid, nama minimal 2 karakter, dan kata sandi minimal 10 karakter diperlukan.'});
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const hash=await bcrypt.hash(password,12);
    const ur=await client.query('INSERT INTO users(email,password_hash,display_name,role) VALUES($1,$2,$3,$4) RETURNING id,email,display_name,role',[email.toLowerCase().trim(),hash,displayName.trim(),'admin']);
    const user=ur.rows[0];
    const er=await client.query('INSERT INTO events(name,owner_id) VALUES($1,$2) RETURNING id,name',[typeof eventName==='string'&&eventName.trim()?eventName.trim().slice(0,120):'Acara pertama',user.id]);
    await client.query('INSERT INTO event_members(event_id,user_id,role) VALUES($1,$2,$3)',[er.rows[0].id,user.id,'admin']);
    await client.query('COMMIT');
    const token=jwt.sign({sub:user.id,email:user.email,role:user.role},secret,{expiresIn:'12h'});
    res.status(201).json({token,user,event:er.rows[0]});
  } catch(e){await client.query('ROLLBACK');if(e.code==='23505')return res.status(409).json({error:'EMAIL_EXISTS'});throw e;} finally{client.release();}
}));
app.post('/api/auth/login',asyncRoute(async(req,res)=>{
  const {email,password}=req.body||{};
  if(typeof email!=='string'||typeof password!=='string')return res.status(400).json({error:'INVALID_INPUT'});
  const r=await pool.query('SELECT id,email,password_hash,display_name,role FROM users WHERE email=$1',[email.toLowerCase().trim()]);
  if(!r.rows[0]||!(await bcrypt.compare(password,r.rows[0].password_hash)))return res.status(401).json({error:'INVALID_CREDENTIALS'});
  const u=r.rows[0];const token=jwt.sign({sub:u.id,email:u.email,role:u.role},secret,{expiresIn:'12h'});
  res.json({token,user:{id:u.id,email:u.email,displayName:u.display_name,role:u.role}});
}));
app.get('/api/me',auth,asyncRoute(async(req,res)=>{const r=await pool.query('SELECT id,email,display_name,role FROM users WHERE id=$1',[req.user.sub]);if(!r.rows[0])return res.status(404).json({error:'USER_NOT_FOUND'});res.json({user:r.rows[0]});}));
app.get('/api/events',auth,asyncRoute(async(req,res)=>{const r=await pool.query('SELECT e.id,e.name,em.role FROM events e JOIN event_members em ON em.event_id=e.id WHERE em.user_id=$1 ORDER BY e.created_at DESC',[req.user.sub]);res.json({events:r.rows});}));
app.get('/api/events/:eventId/invitations',auth,asyncRoute(async(req,res)=>{if(!await membership(req.params.eventId,req.user.sub))return res.status(403).json({error:'EVENT_ACCESS_DENIED'});const r=await pool.query('SELECT id,original_name,status,queue_position,size_bytes,created_at,updated_at FROM invitations WHERE event_id=$1 ORDER BY queue_position,created_at',[req.params.eventId]);res.json({invitations:r.rows});}));
app.post('/api/events/:eventId/invitations',auth,upload.single('image'),asyncRoute(async(req,res)=>{if(!await membership(req.params.eventId,req.user.sub))return res.status(403).json({error:'EVENT_ACCESS_DENIED'});if(!req.file)return res.status(400).json({error:'IMAGE_REQUIRED'});const name=String(req.body.name||req.file.originalname).slice(0,200);const client=await pool.connect();try{await client.query('BEGIN');const pos=await client.query('SELECT COALESCE(MAX(queue_position),0)+1 AS p FROM invitations WHERE event_id=$1',[req.params.eventId]);const r=await client.query('INSERT INTO invitations(event_id,uploaded_by,original_name,stored_name,mime_type,size_bytes,status,queue_position) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,original_name,status,queue_position,size_bytes,created_at',[req.params.eventId,req.user.sub,name,req.file.filename,req.file.mimetype,req.file.size,'QUEUED',pos.rows[0].p]);await client.query('INSERT INTO activity_log(event_id,user_id,action,details) VALUES($1,$2,$3,$4)',[req.params.eventId,req.user.sub,'INVITATION_UPLOADED',JSON.stringify({id:r.rows[0].id,name})]);await client.query('COMMIT');res.status(201).json({invitation:r.rows[0]});}catch(e){await client.query('ROLLBACK');fs.rmSync(req.file.path,{force:true});throw e;}finally{client.release();}}));
app.patch('/api/events/:eventId/invitations/:id/status',auth,asyncRoute(async(req,res)=>{if(!await membership(req.params.eventId,req.user.sub))return res.status(403).json({error:'EVENT_ACCESS_DENIED'});const allowed=['DRAFT','QUEUED','APPROVED','ON_AIR','COMPLETED','FAILED'];if(!allowed.includes(req.body?.status))return res.status(400).json({error:'INVALID_STATUS'});const r=await pool.query('UPDATE invitations SET status=$1,updated_at=NOW() WHERE event_id=$2 AND id=$3 RETURNING id,status,original_name',[req.body.status,req.params.eventId,req.params.id]);if(!r.rows[0])return res.status(404).json({error:'INVITATION_NOT_FOUND'});await logActivity(req.params.eventId,req.user.sub,'STATUS_CHANGED',{id:req.params.id,status:req.body.status});res.json({invitation:r.rows[0]});}));
app.get('/api/events/:eventId/history',auth,asyncRoute(async(req,res)=>{if(!await membership(req.params.eventId,req.user.sub))return res.status(403).json({error:'EVENT_ACCESS_DENIED'});const r=await pool.query('SELECT id,action,details,created_at FROM activity_log WHERE event_id=$1 ORDER BY created_at DESC LIMIT 200',[req.params.eventId]);res.json({history:r.rows});}));
app.use((err,req,res,next)=>{console.error(err);if(err instanceof multer.MulterError)return res.status(err.code==='LIMIT_FILE_SIZE'?413:400).json({error:err.code,message:err.message});if(err.message?.startsWith('Hanya gambar'))return res.status(415).json({error:'UNSUPPORTED_IMAGE'});res.status(500).json({error:'INTERNAL_ERROR',message:process.env.NODE_ENV==='production'?'Terjadi kesalahan server.':err.message});});
app.listen(port,()=>console.log(`DICR API listening on :${port}`));
