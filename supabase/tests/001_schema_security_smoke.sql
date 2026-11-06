-- Execute depois de 0001_initial.sql somente em banco local/descartável.
begin;

do $$
declare
  required_table text;
  required_tables text[] := array[
    'profiles','products','product_applications','price_tables','product_prices',
    'branch_stock','commercial_documents','commercial_document_items','sync_metadata'
  ];
begin
  foreach required_table in array required_tables loop
    if to_regclass('public.' || required_table) is null then
      raise exception 'Tabela obrigatoria ausente: %', required_table;
    end if;
    if not exists (
      select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relname=required_table and c.relrowsecurity
    ) then
      raise exception 'RLS nao habilitada: %', required_table;
    end if;
  end loop;
end;
$$;

do $$
declare
  signature text;
  required_functions text[] := array[
    'public.search_catalog(text,text,text,uuid,text,text,boolean,integer,integer)',
    'public.save_commercial_document(jsonb,jsonb)',
    'public.convert_quotation_to_order(uuid)',
    'public.set_profile_access(uuid,uuid[],uuid[])',
    'public.import_catalog_batch(text,text,jsonb)',
    'public.storage_summary()'
  ];
begin
  foreach signature in array required_functions loop
    if to_regprocedure(signature) is null then
      raise exception 'RPC obrigatoria ausente ou contrato alterado: %', signature;
    end if;
  end loop;
end;
$$;

do $$
declare
  table_name text;
begin
  foreach table_name in array array['products','product_prices','branch_stock','commercial_documents','commercial_document_items'] loop
    if has_table_privilege('anon', 'public.' || table_name, 'SELECT') then
      raise exception 'Anon possui SELECT indevido em %', table_name;
    end if;
  end loop;

  if has_table_privilege('authenticated','public.commercial_documents','INSERT')
     or has_table_privilege('authenticated','public.commercial_documents','UPDATE')
     or has_table_privilege('authenticated','public.commercial_document_items','INSERT')
     or has_table_privilege('authenticated','public.commercial_document_items','UPDATE') then
    raise exception 'Documentos devem ser gravados somente pelas RPCs validadas';
  end if;

  if has_function_privilege('anon','public.import_catalog_batch(text,text,jsonb)','EXECUTE') then
    raise exception 'Anon pode executar import_catalog_batch';
  end if;

  if has_function_privilege('authenticated','public.handle_new_auth_user()','EXECUTE') then
    raise exception 'Trigger de criacao de perfil exposto como RPC';
  end if;
end;
$$;

do $$
begin
  if not public.valid_cnpj('11.222.333/0001-81') then
    raise exception 'Validador rejeitou CNPJ de teste valido';
  end if;
  if public.valid_cnpj('11.111.111/1111-11') or public.valid_cnpj('12.345.678/0001-00') then
    raise exception 'Validador aceitou CNPJ de teste invalido';
  end if;
end;
$$;

do $$
begin
  if (select count(*) from pg_policies where schemaname='public' and tablename='products') < 2 then
    raise exception 'Politicas de products incompletas';
  end if;
  if (select count(*) from pg_policies where schemaname='public' and tablename='commercial_documents') <> 1 then
    raise exception 'Politicas de documentos divergentes do desenho RPC-only';
  end if;
end;
$$;

rollback;
