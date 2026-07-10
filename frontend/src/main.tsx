import React from 'react'
import ReactDOM from 'react-dom/client'
import { CssBaseline, ThemeProvider } from '@mui/material'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import theme from './theme'
import { AuthProvider } from './auth/AuthContext'
import { OrdersProvider } from './orders/OrdersContext'
import ProtectedRoute from './components/ProtectedRoute'
import AppLayout from './components/AppLayout'
import LoginPage from './pages/LoginPage'
import OrdersPage from './pages/OrdersPage'
import OrderThreadPage from './pages/OrderThreadPage'
import MetricsPage from './pages/MetricsPage'
import RevisionAnalyticsPage from './pages/RevisionAnalyticsPage'
import UsersPage from './pages/UsersPage'
import WorkloadPage from './pages/WorkloadPage'
import ChatsPage from './pages/ChatsPage'
import ChatThreadPage from './pages/ChatThreadPage'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <BrowserRouter>
        <AuthProvider>
          <OrdersProvider>
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
                <ProtectedRoute>
                  <AppLayout>
                    <MetricsPage />
                  </AppLayout>
                </ProtectedRoute>
              }
            />
            <Route
              path="/metrics/revisions"
              element={
                <ProtectedRoute>
                  <AppLayout>
                    <RevisionAnalyticsPage />
                  </AppLayout>
                </ProtectedRoute>
              }
            />
            <Route
              path="/workload"
              element={
                <ProtectedRoute>
                  <AppLayout>
                    <WorkloadPage />
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
              path="/users"
              element={
                <ProtectedRoute requireAdmin>
                  <AppLayout>
                    <UsersPage />
                  </AppLayout>
                </ProtectedRoute>
              }
            />
            <Route path="*" element={<Navigate to="/orders" replace />} />
          </Routes>
          </OrdersProvider>
        </AuthProvider>
      </BrowserRouter>
    </ThemeProvider>
  </React.StrictMode>,
)
