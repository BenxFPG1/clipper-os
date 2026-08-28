import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// ✋ Alleen deze emails mogen inloggen
const TOEGESTANE_EMAILS = [
  'zijlstraantonie@gmail.com',
  'malouguyader@gmail.com'
];

export async function POST(request: NextRequest) {
  try {
    const { email, password } = await request.json();

    console.log('📝 Login poging voor:', email);

    if (!email || !password) {
      return NextResponse.json(
        { error: 'Email en wachtwoord zijn verplicht' },
        { status: 400 }
      );
    }

    // 🔍 STAP 1: Check of het emailadres in de lijst staat
    if (!TOEGESTANE_EMAILS.includes(email.toLowerCase())) {
      console.log('❌ Niet-toegestaan emailadres:', email);
      return NextResponse.json(
        { error: 'Geen toegang' },
        { status: 403 }
      );
    }

    // 🔍 STAP 2: Haal gebruiker op uit app_users
    let { data: users, error } = await supabase
      .from('app_users')
      .select('id, email, name, password, is_admin')
      .eq('email', email)
      .order('created_at', { ascending: false })
      .limit(1);

    if (error) {
      console.error('❌ Fout bij ophalen gebruiker:', error);
      return NextResponse.json(
        { error: 'Er is een fout opgetreden' },
        { status: 500 }
      );
    }

    let user = users?.[0] || null;

    // 🔍 STAP 3: Als gebruiker niet bestaat, maak hem aan
    if (!user) {
      console.log('🆕 Nieuwe gebruiker in app_users:', email);

      const isAdmin = email === 'zijlstraantonie@gmail.com' || email === 'malouguyader@gmail.com';

      const { data: newUser, error: createError } = await supabase
        .from('app_users')
        .insert({
          email,
          name: email.split('@')[0],
          password: password,
          is_admin: isAdmin
        })
        .select()
        .single();

      if (createError) {
        console.error('❌ Fout bij aanmaken gebruiker:', createError);
        return NextResponse.json(
          { error: 'Kon gebruiker niet aanmaken' },
          { status: 500 }
        );
      }

      user = newUser;
      console.log('✅ Nieuwe gebruiker aangemaakt in app_users:', email);
    } else {
      // 🔍 STAP 4: Check wachtwoord
      if (user.password !== password) {
        console.log('❌ Wachtwoord incorrect voor:', email);
        return NextResponse.json(
          { error: 'Ongeldige inloggegevens' },
          { status: 401 }
        );
      }

      await supabase
        .from('app_users')
        .update({ 
          last_login_at: new Date().toISOString()
        })
        .eq('id', user.id);
      
      console.log('✅ Wachtwoord correct voor:', email);
    }

    if (!user) {
      return NextResponse.json(
        { error: 'Kon gebruiker niet vinden' },
        { status: 500 }
      );
    }

    // 🔍 STAP 5: Maak sessie aan
    const sessionId = randomUUID();
    await supabase
      .from('sessions')
      .insert({
        id: sessionId,
        user_id: user.id,
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
      });

    console.log('✅ Sessie aangemaakt voor:', email);

    const response = NextResponse.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name || email.split('@')[0],
        is_admin: user.is_admin
      }
    });

    response.cookies.set('session', sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 7,
      path: '/'
    });

    return response;

  } catch (error) {
    console.error('❌ Login error:', error);
    return NextResponse.json(
      { error: 'Er is een fout opgetreden' },
      { status: 500 }
    );
  }
}