// Served at /qr.svg (see vercel.json)
import { handleHttp } from '../server/cloud.js';
export const GET = (req) => handleHttp(req, '/qr.svg');
