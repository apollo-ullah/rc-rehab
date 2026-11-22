// Served at /api/practice.csv (see vercel.json)
import { handleHttp } from '../server/cloud.js';
export const GET = (req) => handleHttp(req, '/api/practice.csv');
