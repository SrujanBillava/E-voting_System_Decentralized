export const getAuthUser = () => {
  try {
    const stored = localStorage.getItem('voter');
    return stored ? JSON.parse(stored) : null;
  } catch (err) {
    return null;
  }
};