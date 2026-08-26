import React from 'react'
import ReactDOM from 'react-dom/client'
import { CssBaseline, ThemeProvider } from '@mui/material'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import theme from './theme'
import { AuthProvider } from './auth/AuthContext'
import ProtectedRoute from './components/ProtectedRoute'
import AppLayout from './components/AppLayout'
import LoginPage from './pages/LoginPage'
import OrdersPage from './pages/OrdersPage'
import OrderThreadPage from './pages/OrderThreadPage'
import MetricsPage from './pages/MetricsPage'
import RevisionAnalyticsPage from './pages/RevisionAnalyticsPage'
import SketchAnalyticsPage from './pages/SketchAnalyticsPage'
import UsersPage from './pages/UsersPage'
import WorkloadPage from './pages/WorkloadPage'
import AssignmentJournalPage from './pages/AssignmentJournalPage'
import ChatsPage from './pages/ChatsPage'
import ChatThreadPage from './pages/ChatThreadPage'
import OrderStatusesPage from './pages/OrderStatusesPage'
import NotificationsPage from './pages/NotificationsPage'
import NotificationBellHost from './components/NotificationBellHost'
import { NotificationsProvider } from './notifications/NotificationsContext'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <BrowserRouter>
        <AuthProvider>
          <NotificationsProvider>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route
                path="/orders"
                element={
                  <ProtectedRoute>
                    <AppLayout>
                      <OrdersPage />
                    </AppLayout>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/orders/:id"
                element={
                  <ProtectedRoute>
                    <AppLayout>
                      <OrderThreadPage />
                    </AppLayout>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/metrics"
                element={
                  <ProtectedRoute requiredScopes={['METRICS_VIEW']}>
                    <AppLayout>
                      <MetricsPage />
                    </AppLayout>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/metrics/revisions"
                element={
                  <ProtectedRoute requiredScopes={['METRICS_VIEW']}>
                    <AppLayout>
                      <RevisionAnalyticsPage />
                    </AppLayout>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/metrics/sketches"
                element={
                  <ProtectedRoute requiredScopes={['METRICS_VIEW']}>
                    <AppLayout>
                      <SketchAnalyticsPage />
                    </AppLayout>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/workload"
                element={
                  <ProtectedRoute requiredScopes={['WORKLOAD_VIEW']}>
                    <AppLayout>
                      <WorkloadPage />
                    </AppLayout>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/workload/journal"
                element={
                  <ProtectedRoute requiredScopes={['WORKLOAD_VIEW']}>
                    <AppLayout>
                      <AssignmentJournalPage />
                    </AppLayout>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/chats"
                element={
                  <ProtectedRoute>
                    <AppLayout>
                      <ChatsPage />
                    </AppLayout>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/chats/:id"
                element={
                  <ProtectedRoute>
                    <AppLayout>
                      <ChatThreadPage />
                    </AppLayout>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/notifications"
                element={
                  <ProtectedRoute>
                    <AppLayout>
                      <NotificationsPage />
                    </AppLayout>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/users"
                element={
                  <ProtectedRoute requireShiftManagement>
                    <AppLayout>
                      <UsersPage />
                    </AppLayout>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/dictionary/statuses"
                element={
                  <ProtectedRoute requireAdmin>
                    <AppLayout>
                      <OrderStatusesPage />
                    </AppLayout>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/dictionary"
                element={<Navigate to="/dictionary/statuses" replace />}
              />
              {/* Старые адреса статусов: и отдельная страница, и /dictionary/orders. */}
              <Route
                path="/order-statuses"
                element={<Navigate to="/dictionary/statuses" replace />}
              />
              <Route
                path="/dictionary/orders"
                element={<Navigate to="/dictionary/statuses" replace />}
              />
              <Route path="*" element={<Navigate to="/orders" replace />} />
            </Routes>
            <NotificationBellHost />
          </NotificationsProvider>
        </AuthProvider>
      </BrowserRouter>
    </ThemeProvider>
  </React.StrictMode>,
)
