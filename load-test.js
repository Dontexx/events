import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '30s', target: 20 },
    { duration: '1m', target: 20 },
    { duration: '30s', target: 50 },
    { duration: '1m', target: 50 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<600'],
  },
};

const API_BASE = 'https://events-l5bd.onrender.com/api';

export default function () {
  // 1. Отримання списку подій
  let res1 = http.get(`${API_BASE}/events`);
  check(res1, { 'GET /events status 200': (r) => r.status === 200 });
  let events = res1.json();
  // 2. Отримання категорій
  let res2 = http.get(`${API_BASE}/categories`);
  check(res2, { 'GET /categories status 200': (r) => r.status === 200 });
  // 3. Отримання конкретної події
  if (events && events.length > 0) {
    let eventId = events[0].id;
    let res3 = http.get(`${API_BASE}/events/${eventId}`);
    check(res3, { 'GET /events/:id status 200': (r) => r.status === 200 });
  }

  sleep(1);
}

