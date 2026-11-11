create or replace function public.import_catalog_batch(import_kind text, source_name text, rows jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  import_kind_value public.catalog_version_kind := upper(import_kind)::public.catalog_version_kind;
  version_key uuid;
  sync_key uuid;
  row_data jsonb;
  product_key uuid;
  table_key uuid;
  branch_key uuid;
  applied integer := 0;
  apps jsonb;
  is_onedrive boolean := source_name like 'onedrive:%';
begin
  if not public.is_admin() then raise exception 'Apenas administradores podem importar'; end if;
  if jsonb_typeof(rows) <> 'array' or jsonb_array_length(rows) = 0 then raise exception 'Lote vazio'; end if;

  insert into public.catalog_versions(kind,label,source_name,row_count,is_active,created_by)
  values(import_kind_value,import_kind_value::text || ' ' || to_char(now(),'YYYY-MM-DD HH24:MI'),source_name,jsonb_array_length(rows),false,auth.uid())
  returning id into version_key;
  insert into public.sync_metadata(source_kind,import_kind,source_name,rows_received,version_id,started_by)
  values(case when is_onedrive then 'ONEDRIVE' else 'MANUAL' end,import_kind_value,source_name,jsonb_array_length(rows),version_key,auth.uid())
  returning id into sync_key;

  begin
    if is_onedrive and import_kind_value = 'PRECOS' then
      update public.product_prices pp
      set valid_to = clock_timestamp()
      where pp.valid_to is null
        and pp.price_table_id in (
          select pt.id from public.price_tables pt where pt.code in ('PR-PR','SP-SP','PR-SC','PR-SP')
        );
    elsif is_onedrive and import_kind_value = 'ESTOQUE' then
      delete from public.branch_stock bs
      using public.branches b
      where b.id = bs.branch_id and b.code in ('PR','SP');
    end if;

    for row_data in select value from jsonb_array_elements(rows) loop
      if import_kind_value in ('PRODUTOS','COMPLETO') then
        if nullif(trim(row_data->>'code'),'') is null or nullif(trim(row_data->>'description'),'') is null then
          raise exception 'Codigo e descricao sao obrigatorios';
        end if;
        insert into public.products(code,description,category,product_line,synonyms,search_text,catalog_version_id)
        values(
          trim(row_data->>'code'),trim(row_data->>'description'),nullif(trim(row_data->>'category'),''),
          nullif(trim(row_data->>'product_line'),''),
          coalesce(array(select jsonb_array_elements_text(coalesce(row_data->'synonyms','[]'::jsonb))),'{}'),
          public.normalize_search(concat_ws(' ',row_data->>'code',row_data->>'description',row_data->>'category',row_data->>'product_line',row_data->>'synonyms')),
          version_key
        )
        on conflict(code) do update set
          description=excluded.description,category=excluded.category,product_line=excluded.product_line,
          synonyms=excluded.synonyms,search_text=excluded.search_text,catalog_version_id=version_key,active=true
        returning id into product_key;
        if row_data ? 'applications' then
          delete from public.product_applications where product_id=product_key;
          for apps in select value from jsonb_array_elements(coalesce(row_data->'applications','[]'::jsonb)) loop
            insert into public.product_applications(product_id,vehicle,model,application,search_text)
            values(
              product_key,nullif(apps->>'vehicle',''),nullif(apps->>'model',''),
              coalesce(nullif(apps->>'application',''),apps#>>'{}'),
              public.normalize_search(concat_ws(' ',apps->>'vehicle',apps->>'model',coalesce(apps->>'application',apps#>>'{}')))
            ) on conflict do nothing;
          end loop;
        end if;
      else
        select id into product_key from public.products where code=trim(row_data->>'code');
        if product_key is null then raise exception 'Produto nao encontrado: %',row_data->>'code'; end if;
      end if;

      if import_kind_value in ('PRECOS','COMPLETO') and row_data ? 'price' then
        select id into table_key from public.price_tables
        where (id::text=row_data->>'price_table_id' or code=row_data->>'price_table_code') and active
        order by version desc limit 1;
        if table_key is null then raise exception 'Tabela de preco nao encontrada'; end if;
        update public.product_prices set valid_to=clock_timestamp()
        where product_id=product_key and price_table_id=table_key and valid_to is null;
        insert into public.product_prices(product_id,price_table_id,price,commercial_version_id)
        values(product_key,table_key,(row_data->>'price')::numeric,version_key);
      end if;

      if import_kind_value in ('ESTOQUE','COMPLETO') and row_data ? 'quantity' then
        select id into branch_key from public.branches where code=upper(row_data->>'origin_code');
        if branch_key is null then raise exception 'Filial nao encontrada'; end if;
        insert into public.branch_stock(product_id,branch_id,quantity,commercial_version_id)
        values(product_key,branch_key,(row_data->>'quantity')::numeric,version_key)
        on conflict(product_id,branch_id) do update set
          quantity=excluded.quantity,commercial_version_id=version_key,updated_at=now();
      end if;
      applied := applied + 1;
    end loop;

    if is_onedrive and import_kind_value = 'PRODUTOS' then
      update public.products p set active=false
      where p.active and not exists (
        select 1 from jsonb_array_elements(rows) incoming where trim(incoming.value->>'code') = p.code
      );
    end if;

    update public.catalog_versions set is_active=false where kind=import_kind_value and id<>version_key;
    update public.catalog_versions set is_active=true where id=version_key;
    update public.sync_metadata set status='CONCLUIDO',rows_applied=applied,finished_at=now() where id=sync_key;
    return jsonb_build_object('ok',true,'version_id',version_key,'rows_applied',applied,'sync_id',sync_key);
  exception when others then
    update public.sync_metadata set status='FALHOU',error_count=1,error_message=left(sqlerrm,1000),finished_at=now() where id=sync_key;
    return jsonb_build_object('ok',false,'error',sqlerrm,'sync_id',sync_key);
  end;
end;
$$;

grant execute on function public.import_catalog_batch(text,text,jsonb) to authenticated, service_role;
