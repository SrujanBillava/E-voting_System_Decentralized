import Voter from '../models/Voter.js';
import generateVoterAuthToken from '../utils/generateVoterAuthToken.js';
import bcrypt from 'bcryptjs';

export const loginVoter = async (req, res) => {
  const { email, password } = req.body;
  console.log('Login request received:', { email });

  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required' });
  }

  const voter = await Voter.findOne({ email }).select('+password');
  if (!voter) {
    return res.status(401).json({ message: 'Invalid email or password' });
  }

  const isMatch = await bcrypt.compare(password, voter.password);
  if (isMatch) {
    res.status(200).json({
      _id: voter._id,
      VoterId: voter.VoterId,
      name: voter.name,
      email: voter.email,
      constituency: voter.constituency,
      contact: voter.contact,
      Address: voter.Address,
      token: generateVoterAuthToken(voter._id)
    });
  } else {
    res.status(401).json({ message: 'Invalid email or password' });
  }
};