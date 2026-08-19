import jwt from 'jsonwebtoken';

const generateVoterAuthToken = (id) => {
  return jwt.sign({ id }, process.env.VOTER_JWT_SECRET, {
    expiresIn: '1h', // Token expires in 1 hour
  });
};

export default generateVoterAuthToken;