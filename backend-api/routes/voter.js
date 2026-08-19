import express from 'express';
import { loginVoter } from '../controllers/voter.js';
import protectRoute from '../middleware/voterProtect.js';

const router = express.Router();

router.post('/login', loginVoter);

export default router;