import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import dbConnect from '../../../../lib/mongodb'
import Evaluation from '../../../../lib/models/Evaluation'
import { isAuthorizedOperator } from '../../../../lib/security'

export async function POST(request: NextRequest) {
  try {
    const { userId, sessionClaims } = await auth()

    if (!userId || !isAuthorizedOperator(request, sessionClaims)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    await dbConnect()

    // Find evaluations that have been processing for more than 10 minutes
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000)
    
    const stuckEvaluations = await Evaluation.find({
      status: 'processing',
      updatedAt: { $lt: tenMinutesAgo }
    })

    console.log(`Found ${stuckEvaluations.length} stuck evaluations`)

    if (stuckEvaluations.length > 0) {
      // Reset stuck evaluations to 'failed' status with a clear message
      const result = await Evaluation.updateMany(
        {
          status: 'processing',
          updatedAt: { $lt: tenMinutesAgo }
        },
        {
          $set: {
            status: 'failed',
            suggestions: ['Processing timed out. Please try uploading your file again.'],
            updatedAt: new Date()
          }
        }
      )

      return NextResponse.json({
        message: `Reset ${result.modifiedCount} stuck evaluations`,
        count: result.modifiedCount,
        evaluations: stuckEvaluations.map(e => ({
          id: e._id.toString(),
          fileName: e.fileName,
          stuckSince: e.updatedAt
        }))
      })
    }

    return NextResponse.json({
      message: 'No stuck evaluations found',
      count: 0
    })

  } catch (error) {
    console.error('Error resetting stuck evaluations:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
