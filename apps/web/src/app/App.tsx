import type { Role } from '@zapas/shared';
import { lazy, Suspense, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { useScope } from '../auth/ScopeProvider';
import { Loading } from '../components/Feedback/Feedback';
import { AppLayout } from '../components/Layout/AppLayout';

const TestingPage = lazy(() => import('../pages/Testing/TestingPage'));
const LoginPage = lazy(() => import('../pages/Login/LoginPage'));
const DashboardPage = lazy(() => import('../pages/Dashboard/DashboardPage'));
const StockPage = lazy(() => import('../pages/Stock/StockPage'));
const OperationsPage = lazy(() => import('../pages/Operations/OperationsPage'));
const InventoryListPage = lazy(() => import('../pages/Inventory/InventoryListPage'));
const InventoryPage = lazy(() => import('../pages/Inventory/InventoryPage'));
const StopListPage = lazy(() => import('../pages/StopList/StopListPage'));
const RecommendationsPage = lazy(() => import('../pages/Recommendations/RecommendationsPage'));
const HotDishesPage = lazy(() => import('../pages/HotDishes/HotDishesPage'));
const SuppliersPage = lazy(() => import('../pages/Suppliers/SuppliersPage'));
const HaccpPage = lazy(() => import('../pages/Haccp/HaccpPage'));
const GuidePage = lazy(() => import('../pages/Guide/GuidePage'));
const OrdersPage = lazy(() => import('../pages/Orders/OrdersPage'));
const TraceabilityPage = lazy(() => import('../pages/Traceability/TraceabilityPage'));
const ProductsPage = lazy(() => import('../pages/Products/ProductsPage'));
const DishesPage = lazy(() => import('../pages/Dishes/DishesPage'));
const ReportsPage = lazy(() => import('../pages/Reports/ReportsPage'));
const AdminPage = lazy(() => import('../pages/Admin/AdminPage'));
const NotFoundPage = lazy(() => import('../pages/NotFound/NotFoundPage'));
const RegisterPage = lazy(() => import('../pages/Login/RegisterPage'));
const SelectLocationPage = lazy(() => import('../pages/Select/SelectLocationPage'));
const ForcedPasswordPage = lazy(() => import('../pages/Login/ForcedPasswordPage'));
const WaiterLayout = lazy(() => import('../pages/Waiter/WaiterLayout'));
const WaiterOrderPage = lazy(() => import('../pages/Waiter/WaiterOrderPage'));
const WaiterOrdersPage = lazy(() => import('../pages/Waiter/WaiterOrdersPage'));
const WaiterHotPage = lazy(() => import('../pages/Waiter/WaiterHotPage'));
const WaiterStopPage = lazy(() => import('../pages/Waiter/WaiterStopPage'));

function Protected({ children }: { children: ReactNode }) {
  const { status, user } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <Loading label="Проверяем сессию" />;
  if (status === 'anonymous') return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  // пароль выдал администратор: до смены доступна только страница смены пароля
  if (user?.mustChangePassword) return <ForcedPasswordPage />;
  return <>{children}</>;
}

/** Страницы, которые работают в выбранном заведении. Пока оно не выбрано, показываем выбор. */
function RequireLocation({ children }: { children: ReactNode }) {
  const scope = useScope();
  const location = useLocation();
  if (scope.loading) return <Loading label="Загружаем заведения" />;
  const exempt = location.pathname === '/admin' || location.pathname === '/guide';
  if (!scope.selected && !exempt) return <Navigate to="/select" replace />;
  return <>{children}</>;
}

/** Официант видит только свои экраны, остальные роли их не видят. */
function RoleSplit({ waiter, children }: { waiter: boolean; children: ReactNode }) {
  const { user } = useAuth();
  const isWaiter = user?.role === 'waiter';
  if (isWaiter && !waiter) return <Navigate to="/waiter" replace />;
  if (!isWaiter && waiter) return <Navigate to="/" replace />;
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
        <Route path="/register" element={<RegisterPage />} />
        <Route
          path="/select"
          element={
            <Protected>
              <SelectLocationPage />
            </Protected>
          }
        />
        <Route
          path="/waiter"
          element={
            <Protected>
              <RoleSplit waiter>
                <RequireLocation>
                  <WaiterLayout />
                </RequireLocation>
              </RoleSplit>
            </Protected>
          }
        >
          <Route index element={<WaiterOrderPage />} />
          <Route path="orders" element={<WaiterOrdersPage />} />
          <Route path="hot" element={<WaiterHotPage />} />
          <Route path="stop" element={<WaiterStopPage />} />
        </Route>
        <Route
          element={
            <Protected>
              <RoleSplit waiter={false}>
                <RequireLocation>
                  <AppLayout />
                </RequireLocation>
              </RoleSplit>
            </Protected>
          }
        >
          <Route index element={<DashboardPage />} />
          <Route path="guide" element={<GuidePage />} />
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
          <Route
            path="suppliers"
            element={
              <RequireRole min="manager">
                <SuppliersPage />
              </RequireRole>
            }
          />
          <Route path="haccp" element={<HaccpPage />} />
          <Route path="stop-list" element={<StopListPage />} />
          <Route path="hot-dishes" element={<HotDishesPage />} />
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
            path="testing"
            element={
              <RequireRole min="manager">
                <TestingPage />
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
