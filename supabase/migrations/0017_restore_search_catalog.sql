-- Restaura o nome original da funcao: o corpo PL/pgSQL referencia
-- search_catalog.price_table_id para distinguir o parametro da coluna.
-- A deduplicacao continua garantida no indice e no frontend/exportadores.

begin;

drop function if exists public.search_catalog(text,text,text,uuid,text,text,boolean,integer,integer);

alter function public.search_catalog_raw(text,text,text,uuid,text,text,boolean,integer,integer)
rename to search_catalog;

revoke all on function public.search_catalog(text,text,text,uuid,text,text,boolean,integer,integer)
from public,anon;
grant execute on function public.search_catalog(text,text,text,uuid,text,text,boolean,integer,integer)
to authenticated;

commit;
