import { LinkButton } from '../../components/Button/Button';
import { EmptyState } from '../../components/Feedback/Feedback';

export default function NotFoundPage() {
  return (
    <EmptyState title="Такой страницы нет" action={<LinkButton to="/" variant="primary">На обзор</LinkButton>}>
      Возможно, ссылка устарела или раздел недоступен для вашей роли.
    </EmptyState>
  );
}
