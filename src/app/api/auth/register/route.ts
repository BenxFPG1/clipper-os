import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(request: NextRequest) {
  try {
    const { email, name, password } = await request.json();

    if (!email || !password) {
      return NextResponse.json(
        { error: 'Email en wachtwoord zijn verplicht' },
        { status: 400 }
      );
    }

    if (password.length < 6) {
      return NextResponse.json(
        { error: 'Wachtwoord moet minimaal 6 tekens zijn' },
        { status: 400 }
      );
    }

    // Check of gebruiker al bestaat in app_users
    const { data: existing } = await supabase
      .from('app_users')
      .select('email')
      .eq('email', email)
      .maybeSingle();

    if (existing) {
      return NextResponse.json(
        { error: 'Dit emailadres is al geregistreerd' },
        { status: 409 }
      );
    }

    const adminEmail = process.env.ADMIN_EMAIL || 'jouw.email@bedrijf.nl';
    const isAdmin = email === adminEmail;

    console.log('Admin email:', adminEmail);
    console.log('Is admin?', isAdmin);

    // Sla gebruiker op in app_users
    const { data: user, error } = await supabase
      .from('app_users')
      .insert({
        email,
        name: name || email.split('@')[0],
        password: password,
        is_admin: isAdmin
      })
      .select('id, email, name, is_admin, created_at')
      .single();

    if (error) {
      console.error('Registratie fout:', error);
      return NextResponse.json(
        { error: 'Kon gebruiker niet aanmaken: ' + error.message },
        { status: 500 }
      );
    }

    console.log('Gebruiker aangemaakt:', user);

    return NextResponse.json({ success: true, user });
  } catch (error) {
    console.error('Registratie error:', error);
    return NextResponse.json(
      { error: 'Er is een fout opgetreden: ' + (error as Error).message },
      { status: 500 }
    );
  }
}