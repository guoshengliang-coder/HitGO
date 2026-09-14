import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { MOCK } from './api';
import './styles.css';

async function boot() {
  if (MOCK) {
    const { setupMocks } = await import('./mocks');
    setupMocks();
  }
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </React.StrictMode>,
  );
}

void boot();
