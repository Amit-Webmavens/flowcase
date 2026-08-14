import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { App } from './App.js';
import { TestsPage } from './pages/TestsPage.js';
import { TestEditorPage } from './pages/TestEditorPage.js';
import { RunsPage } from './pages/RunsPage.js';
import { RunPage } from './pages/RunPage.js';
import { RecorderPage } from './pages/RecorderPage.js';
import { EnvironmentsPage } from './pages/EnvironmentsPage.js';
import { SnippetsPage } from './pages/SnippetsPage.js';
import { SchedulesPage } from './pages/SchedulesPage.js';
import './index.css';

const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <TestsPage /> },
      { path: 'tests/:id', element: <TestEditorPage /> },
      { path: 'runs', element: <RunsPage /> },
      { path: 'runs/:id', element: <RunPage /> },
      { path: 'recorder', element: <RecorderPage /> },
      { path: 'snippets', element: <SnippetsPage /> },
      { path: 'schedules', element: <SchedulesPage /> },
      { path: 'environments', element: <EnvironmentsPage /> },
    ],
  },
]);

const container = document.getElementById('root');

if (container) {
  createRoot(container).render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  );
}
