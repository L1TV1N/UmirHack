import type { Role } from '@zapas/shared';
import { lazy, Suspense, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { Loading } from '../components/Feedback/Feedback';
import { AppLayout } from '../components/Layout/AppLayout';

const LoginPage = lazy(() => import('../pages/Login/LoginPage'));
const DashboardPage = lazy(() => import('../pages/Dashboard/DashboardPage'));
const StockPage = lazy(() => import('../pages/Stock/StockPage'));
const OperationsPage = lazy(() => import('../pages/Operations/OperationsPage'));
const InventoryListPage = lazy(() => import('../pages/Inventory/InventoryListPage'));
const InventoryPage = lazy(() => import('../pages/Inventory/InventoryPage'));
const StopListPage = lazy(() => import('../pages/StopList/StopListPage'));
const RecommendationsPage = lazy(() => import('../pages/Recommendations/RecommendationsPage'));
const OrdersPage = lazy(() => import('../pages/Orders/OrdersPage'));
const TraceabilityPage = lazy(() => import('../pages/Traceability/TraceabilityPage'));
const ProductsPage = lazy(() => import('../pages/Products/ProductsPage'));
const DishesPage = lazy(() => import('../pages/Dishes/DishesPage'));
const ReportsPage = lazy(() => import('../pages/Reports/ReportsPage'));
const AdminPage = lazy(() => import('../pages/Admin/AdminPage'));
const NotFoundPage = lazy(() => import('../pages/NotFound/NotFoundPage'));

function Protected({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <Loading label="Проверяем сессию" />;
  if (status === 'anonymous') return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <>{children}</>;
}

function RequireRole({ min, children }: { min: Role; children: ReactNode }) {
  const { can } = useAuth();
  if (!can(min)) return <Navigate to="/" replace />;
  return <>{children}</>;
}

export function App() {
  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          element={
            <Protected>
              <AppLayout />
            </Protected>
          }
        >
          <Route index element={<DashboardPage />} />
          <Route path="stock" element={<StockPage />} />
          <Route path="operations" element={<OperationsPage />} />
          <Route path="inventory" element={<InventoryListPage />} />
          <Route path="inventory/:id" element={<InventoryPage />} />
          <Route
            path="orders"
            element={
              <RequireRole min="manager">
                <OrdersPage />
              </RequireRole>
            }
          />
          <Route
            path="traceability"
            element={
              <RequireRole min="storekeeper">
                <TraceabilityPage />
              </RequireRole>
            }
          />
          <Route path="stop-list" element={<StopListPage />} />
          <Route path="recommendations" element={<RecommendationsPage />} />
          <Route path="products" element={<ProductsPage />} />
          <Route path="dishes" element={<DishesPage />} />
          <Route
            path="reports"
            element={
              <RequireRole min="manager">
                <ReportsPage />
              </RequireRole>
            }
          />
          <Route
            path="admin"
            element={
              <RequireRole min="admin">
                <AdminPage />
              </RequireRole>
            }
          />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
