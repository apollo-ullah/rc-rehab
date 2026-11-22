import { handleHttp } from '../server/cloud.js';
export const GET = (req) => handleHttp(req, '/api/info');
