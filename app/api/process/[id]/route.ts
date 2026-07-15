import { NextRequest, NextResponse } from 'next/server'

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  return NextResponse.json({
    error: 'Manual processing is disabled. Evaluations are processed from their original queued payload.',
    evaluationId: id
  }, { status: 410 })
}
