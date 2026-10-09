-- Поиск по отсканированному коду: EAN-13, UPC-A и GTIN-14 одного товара отличаются только нулями слева,
-- поэтому сравниваем выровненные до 14 знаков значения.
CREATE INDEX products_gtin_idx ON products ((lpad(barcode, 14, '0'))) WHERE barcode IS NOT NULL;
