import axios from 'axios';

const API = axios.create({
  baseURL: import.meta.env.VITE_API_URL,
});

export default API;
const authUser = JSON.parse(localStorage.getItem('voter') || '{}');
const token = authUser?.token;

export const getWishlist = () =>
  API.get('/wishlist', {
    headers: { Authorization: `Bearer ${token}` },
  });

export const addToWishlist = (productId: string) =>
  API.post(
    '/wishlist',
    { productId },
    { headers: { Authorization: `Bearer ${token}` } }
  );

export const removeFromWishlist = (productId: string) =>
  API.delete(`/wishlist/${productId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
