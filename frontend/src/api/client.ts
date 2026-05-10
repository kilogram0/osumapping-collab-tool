import axios from 'axios';

const client = axios.create({
  baseURL: '/api',
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
  },
});

client.interceptors.request.use((config) => {
  if (config.method && config.method.toLowerCase() !== 'get') {
    config.headers['X-Requested-With'] = 'XMLHttpRequest';
  }
  return config;
});

export default client;
