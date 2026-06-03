// ============================================
// Módulo de Conexão com Supabase
// ============================================
// Este módulo configura e exporta o cliente Supabase
// para uso em todo o backend
// ============================================

import { createClient } from '@supabase/supabase-js';

// Obter variáveis de ambiente
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

// Validar variáveis de ambiente (mas não quebrar o servidor se não estiverem configuradas)
// Isso permite que o servidor funcione mesmo sem Supabase (modo compatibilidade)
let supabase = null;
let supabaseAvailable = false;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.warn('⚠️ [Supabase] Variáveis de ambiente não configuradas!');
  console.warn('⚠️ [Supabase] O servidor continuará funcionando, mas Supabase não estará disponível');
  console.warn('⚠️ [Supabase] Configure as variáveis: SUPABASE_URL e SUPABASE_SERVICE_KEY');
  console.warn('⚠️ [Supabase] O sistema usará arquivos Excel até que Supabase seja configurado');
} else {
  try {
    // Criar cliente Supabase com service_role key (acesso total ao banco)
    // Usamos service_role porque o backend precisa de acesso completo
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      },
      db: {
        schema: 'public'
      }
    });
    supabaseAvailable = true;
    console.log('✅ [Supabase] Cliente criado com sucesso');
  } catch (err) {
    console.error('❌ [Supabase] Erro ao criar cliente:', err.message);
    console.warn('⚠️ [Supabase] O servidor continuará funcionando sem Supabase');
  }
}

// Cliente com anon key (para uso futuro, se necessário)
// Só cria se SUPABASE_URL e SUPABASE_ANON_KEY estiverem configurados
const supabaseAnon = (SUPABASE_URL && SUPABASE_ANON_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    })
  : null;

// Função para testar conexão com Supabase
export async function testSupabaseConnection() {
  if (!supabaseAvailable || !supabase) {
    return { 
      success: false, 
      error: 'Supabase não configurado. Configure SUPABASE_URL e SUPABASE_SERVICE_KEY' 
    };
  }
  
  try {
    console.log('🔍 [Supabase] Testando conexão...');
    console.log('🔍 [Supabase] URL:', SUPABASE_URL);
    
    // Testar conexão fazendo uma query simples
    const { data, error } = await supabase
      .from('projetistas')
      .select('count')
      .limit(1);
    
    if (error) {
      // Se a tabela não existir, ainda é uma conexão válida (erro de tabela, não de conexão)
      if (error.code === 'PGRST116' || error.message.includes('does not exist')) {
        console.log('⚠️ [Supabase] Conexão OK, mas tabela ainda não existe (normal se schema não foi executado)');
        return { success: true, message: 'Conexão OK (tabela não existe ainda)' };
      }
      throw error;
    }
    
    console.log('✅ [Supabase] Conexão estabelecida com sucesso!');
    return { success: true, message: 'Conexão OK' };
  } catch (err) {
    console.error('❌ [Supabase] Erro ao testar conexão:', err.message);
    console.error('❌ [Supabase] Stack:', err.stack);
    return { success: false, error: err.message };
  }
}

// Função para verificar se as tabelas existem
export async function checkTables() {
  if (!supabaseAvailable || !supabase) {
    return { 
      error: 'Supabase não configurado. Configure SUPABASE_URL e SUPABASE_SERVICE_KEY' 
    };
  }
  
  try {
    console.log('🔍 [Supabase] Verificando tabelas...');
    
    const tables = ['ctos', 'projetistas', 'tabulacoes', 'vi_ala', 'upload_history', 'relatorios_b2b'];
    const results = {};
    
    for (const table of tables) {
      try {
        const { error } = await supabase
          .from(table)
          .select('*')
          .limit(1);
        
        if (error) {
          if (error.code === 'PGRST116' || error.message.includes('does not exist')) {
            results[table] = { exists: false, error: 'Tabela não existe' };
          } else {
            results[table] = { exists: false, error: error.message };
          }
        } else {
          results[table] = { exists: true };
        }
      } catch (err) {
        results[table] = { exists: false, error: err.message };
      }
    }
    
    console.log('📊 [Supabase] Status das tabelas:', results);
    return results;
  } catch (err) {
    console.error('❌ [Supabase] Erro ao verificar tabelas:', err);
    return { error: err.message };
  }
}

// Exportar cliente principal (com service_role - acesso total)
// Pode ser null se não estiver configurado
export default supabase;

// Exportar flag de disponibilidade
export const isSupabaseAvailable = () => supabaseAvailable;

// Exportar cliente anon (se necessário no futuro)
export { supabaseAnon };

// Exportar informações de configuração (para debug)
export const supabaseConfig = {
  url: SUPABASE_URL || 'Não configurado',
  hasServiceKey: !!SUPABASE_SERVICE_KEY,
  hasAnonKey: !!SUPABASE_ANON_KEY,
  available: supabaseAvailable
};

// Log de inicialização
if (supabaseAvailable) {
  console.log('✅ [Supabase] Módulo carregado e configurado');
  console.log('✅ [Supabase] URL:', SUPABASE_URL);
  console.log('✅ [Supabase] Service Key configurada:', !!SUPABASE_SERVICE_KEY);
  console.log('✅ [Supabase] Anon Key configurada:', !!SUPABASE_ANON_KEY);
} else {
  console.log('⚠️ [Supabase] Módulo carregado, mas não configurado');
  console.log('⚠️ [Supabase] O sistema usará arquivos Excel até que Supabase seja configurado');
}

