-- Журнал документов открывается без фильтров: страницу нужно брать по индексу, а не сортировать все документы
CREATE INDEX documents_created_idx ON documents (created_at DESC, number DESC);
