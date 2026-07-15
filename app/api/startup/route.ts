import { NextResponse } from 'next/server'
import { initializeServices } from '../../../lib/startup'
import { auth } from '@clerk/nextjs/server'
import { isAuthorizedOperator } from '../../../lib/security'

// This endpoint can be called by Vercel's deployment hooks or monitoring services
export async function GET(request: Request) {
  try {
    const { sessionClaims } = await auth()
    if (!isAuthorizedOperator(request, sessionClaims)) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
    }
    await initializeServices()
    
    return NextResponse.json({
      success: true,
      message: 'Services started successfully',
      timestamp: new Date().toISOString()
    })
  } catch (error) {
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 })
  }
}

export async function POST(request: Request) {
  // Same as GET for flexibility
  return GET(request)
}
