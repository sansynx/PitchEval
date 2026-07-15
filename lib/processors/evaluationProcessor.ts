import dbConnect from '../mongodb'
import Evaluation from '../models/Evaluation'
import Hackathon from '../models/Hackathon'
import { evaluatePresentationFile } from '../ai/gemini'
import { generateFileHash, getCachedEvaluation, setCachedEvaluation } from '../cache'
import { EvaluationJob, PersonalEvaluationJob, HackathonEvaluationJob } from '../queue'
import { logger } from '../logger'

// Process personal evaluation job with timeout handling
export async function processPersonalEvaluation(job: PersonalEvaluationJob): Promise<void> {
  const startTime = Date.now()
  const TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes timeout

  try {
    await dbConnect()

    // Update status to processing
    await Evaluation.findByIdAndUpdate(job.evaluationId, {
      status: 'processing',
      updatedAt: new Date(),
    })

    // Convert base64 back to file buffer
    const fileBuffer = Buffer.from(job.fileBuffer, 'base64')

    // Create File object for AI processing
    const file = new File([fileBuffer], job.fileName, { type: 'application/pdf' })

    // Generate file hash for caching
    const fileHash = generateFileHash(fileBuffer, job.fileName)

    logger.debug('Processing personal evaluation', { fileName: job.fileName })

    // Check Redis cache with context
    const cachedResult = await getCachedEvaluation(fileHash, job.domain, {
      evaluationType: 'personal',
      description: job.description,
      userId: job.userId
    })

    let aiResult
    if (cachedResult) {
      logger.debug('Cache HIT for personal evaluation')
      aiResult = {
        scores: cachedResult.scores,
        suggestions: cachedResult.suggestions,
        detectedDomain: cachedResult.detectedDomain
      }
    } else {
      logger.debug('Cache MISS for personal evaluation - Processing with AI')
      
      // Check timeout before AI processing
      if (Date.now() - startTime > TIMEOUT_MS) {
        throw new Error('Processing timeout exceeded before AI evaluation')
      }

      // Process with AI with timeout wrapper
      aiResult = await Promise.race([
        evaluatePresentationFile(file, job.domain, job.description),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('AI processing timeout')), TIMEOUT_MS - (Date.now() - startTime))
        )
      ]) as any

      // Cache the result
      await setCachedEvaluation(fileHash, job.domain, {
        scores: aiResult.scores,
        suggestions: aiResult.suggestions,
        domain: aiResult.detectedDomain?.category || job.domain,
        detectedDomain: aiResult.detectedDomain,
        fileName: job.fileName,
        createdAt: new Date().toISOString()
    }, {
      evaluationType: 'personal',
      description: job.description,
      userId: job.userId
      })
    }

    // Update evaluation in database
    await Evaluation.findByIdAndUpdate(job.evaluationId, {
      scores: aiResult.scores,
      suggestions: aiResult.suggestions,
      domain: aiResult.detectedDomain?.category || job.domain,
      detectedDomain: aiResult.detectedDomain,
      status: 'completed',
      updatedAt: new Date(),
    }, { runValidators: true })

    logger.info('Personal evaluation completed', { 
      fileName: job.fileName, 
      duration: Date.now() - startTime 
    })

  } catch (error) {
    console.error('Personal evaluation processing failed:', error)

    // Determine if it's a timeout error
    const isTimeout = error instanceof Error && 
      (error.message.includes('timeout') || Date.now() - startTime > TIMEOUT_MS)

    // Update evaluation with appropriate error status
    await Evaluation.findByIdAndUpdate(job.evaluationId, {
      status: 'failed',
      suggestions: isTimeout 
        ? ['Processing timed out. Please try uploading your file again. Large files may take longer to process.']
        : ['Processing failed. Please try uploading your file again.'],
      updatedAt: new Date(),
    })

    throw error
  }
}

// Process hackathon evaluation job with timeout handling
export async function processHackathonEvaluation(job: HackathonEvaluationJob): Promise<void> {
  const startTime = Date.now()
  const TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes timeout

  try {
    await dbConnect()

    // Update status to processing
    await Evaluation.findByIdAndUpdate(job.evaluationId, {
      status: 'processing',
      updatedAt: new Date(),
    })

    // Convert base64 back to file buffer
    const fileBuffer = Buffer.from(job.fileBuffer, 'base64')

    // Create File object for AI processing
    const file = new File([fileBuffer], job.fileName, { type: 'application/pdf' })

    // Get hackathon details
    const hackathon = await Hackathon.findById(job.hackathonId)
    if (!hackathon) {
      throw new Error('Hackathon not found')
    }

    // Generate file hash for caching
    const fileHash = generateFileHash(fileBuffer, job.fileName)

    logger.debug('Processing hackathon evaluation')

    // Check timeout before processing
    if (Date.now() - startTime > TIMEOUT_MS) {
      throw new Error('Processing timeout exceeded before evaluation')
    }

    // Log template validation status for debugging
    if (job.templateAnalysis) {
      logger.debug('Job includes template analysis data - validation enabled')
    } else if (hackathon.templateAnalysis) {
      logger.debug('Hackathon has template analysis - will fetch from database if needed')
    } else {
      logger.debug('No template analysis available - standard evaluation only')
    }

    // Check Redis cache with full context (tracks, weights, template)
    const cacheContext = {
      evaluationType: 'hackathon' as const,
      tracks: hackathon.tracks,
      weights: hackathon.weights,
      hasTemplate: !!(job.templateAnalysis || hackathon.templateAnalysis),
      templateFingerprint: job.templateAnalysis?.fingerprint,
      templateContext: [hackathon.additionalInfo, job.templateAnalysis?.additionalContext].filter(Boolean).join('\n'),
      userId: job.userId
    }
    
    const cachedResult = await getCachedEvaluation(fileHash, 'hackathon', cacheContext)

    let aiResult
    let templateValidation = null

    if (cachedResult) {
      logger.debug('Cache HIT for hackathon evaluation')
      aiResult = {
        scores: cachedResult.scores,
        suggestions: cachedResult.suggestions,
        trackRelevance: (cachedResult as any).trackRelevance
      }

      // Retrieve cached template validation if available
      templateValidation = (cachedResult as any).templateValidation || null

      if (templateValidation) {
        logger.debug('Using cached template validation', { compliance: templateValidation.overallCompliance })
      }
    } else {
      logger.debug('Cache MISS for hackathon evaluation - Processing with AI')
      
      // Check timeout before AI processing
      if (Date.now() - startTime > TIMEOUT_MS) {
        throw new Error('Processing timeout exceeded before AI evaluation')
      }

      // Process with AI including track information and template with timeout wrapper
      aiResult = await Promise.race([
        evaluatePresentationFile(file, 'hackathon', undefined, hackathon.tracks),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('AI processing timeout')), TIMEOUT_MS - (Date.now() - startTime))
        )
      ]) as any

      // Perform template validation if template analysis exists and validation is requested
      if (job.templateAnalysis && (job.includeTemplateValidation !== false)) {
        const { validateSubmissionAgainstTemplate, shouldSkipTemplateValidation, logValidationError } = await import('../ai/validationEngine')

        // Check if validation should be skipped
        if (shouldSkipTemplateValidation(job.templateAnalysis)) {
          logger.debug('Skipping template validation: insufficient template data')
          templateValidation = null
        } else {
          try {
            logger.debug('Performing template validation')

            // Use template analysis data from job (more efficient than database lookup)
            const templateAnalysisResult = {
              structure: job.templateAnalysis.structure,
              theme: job.templateAnalysis.theme,
              fingerprint: job.templateAnalysis.fingerprint,
              additionalContext: job.templateAnalysis.additionalContext
            }

            // Combine hackathon additional info with template context for comprehensive validation
            const combinedContext = [
              hackathon.additionalInfo,
              job.templateAnalysis.additionalContext
            ].filter(Boolean).join('\n\n')

            const validationResult = await validateSubmissionAgainstTemplate(
              file,
              templateAnalysisResult,
              combinedContext || undefined
            )

            templateValidation = {
              themeMatch: {
                score: validationResult.themeMatch.score,
                reasoning: validationResult.themeMatch.reasoning
              },
              structureAdherence: {
                score: validationResult.structureAdherence.score,
                deviations: validationResult.structureAdherence.deviations
              },
              overallCompliance: validationResult.overallCompliance
            }

            logger.debug('Template validation completed', { compliance: validationResult.overallCompliance })

          } catch (validationError) {
            logValidationError(job.fileName, validationError as Error, 'primary validation')

            // Continue with standard evaluation - system remains functional
            logger.debug('Continuing with standard evaluation - template validation will be skipped')
            templateValidation = null
          }
        }
      } else if (hackathon.templateAnalysis && (job.includeTemplateValidation !== false)) {
        // Fallback: If job doesn't have template analysis but hackathon does, fetch from database
        try {
          logger.debug('Fetching template analysis from database')
          const TemplateAnalysis = (await import('../models/TemplateAnalysis')).default
          const templateAnalysisData = await TemplateAnalysis.findById(hackathon.templateAnalysis)

          if (templateAnalysisData) {
            const { validateSubmissionAgainstTemplate } = await import('../ai/validationEngine')

            const templateAnalysisResult = {
              structure: templateAnalysisData.structure,
              theme: templateAnalysisData.theme,
              fingerprint: templateAnalysisData.fingerprint,
              additionalContext: templateAnalysisData.additionalContext
            }

            const combinedContext = [
              hackathon.additionalInfo,
              templateAnalysisData.additionalContext
            ].filter(Boolean).join('\n\n')

            const validationResult = await validateSubmissionAgainstTemplate(
              file,
              templateAnalysisResult,
              combinedContext || undefined
            )

            templateValidation = {
              themeMatch: {
                score: validationResult.themeMatch.score,
                reasoning: validationResult.themeMatch.reasoning
              },
              structureAdherence: {
                score: validationResult.structureAdherence.score,
                deviations: validationResult.structureAdherence.deviations
              },
              overallCompliance: validationResult.overallCompliance
            }

            logger.debug('Template validation completed (fallback)', { compliance: validationResult.overallCompliance })
          }
        } catch (validationError) {
          const { logValidationError } = await import('../ai/validationEngine')
          logValidationError(job.fileName, validationError as Error, 'fallback validation')
          logger.debug('Continuing with standard evaluation - all template validation attempts failed')
          templateValidation = null
        }
      } else {
        logger.debug('No template analysis available for hackathon, skipping template validation')
      }

      // Cache the result including template validation
      const cacheData: any = {
        scores: aiResult.scores,
        suggestions: aiResult.suggestions,
        domain: 'hackathon',
        fileName: job.fileName,
        createdAt: new Date().toISOString()
      }

      // Add track relevance if available
      if (aiResult.trackRelevance) {
        cacheData.trackRelevance = aiResult.trackRelevance
      }

      // Add template validation if available
      if (templateValidation) {
        cacheData.templateValidation = templateValidation
      }

      await setCachedEvaluation(fileHash, 'hackathon', cacheData, cacheContext)
    }

    const scoreValues = [
      aiResult.scores.innovation,
      aiResult.scores.feasibility,
      aiResult.scores.impact,
      aiResult.scores.clarity,
      job.weights.innovation,
      job.weights.feasibility,
      job.weights.impact,
      job.weights.clarity
    ]
    if (!scoreValues.every((value: unknown) => typeof value === 'number' && Number.isFinite(value))) {
      throw new Error('Evaluation contained invalid scores or weights')
    }

    // Calculate weighted overall score from validated finite values.
    const weightedScore = (
      (aiResult.scores.innovation * job.weights.innovation / 100) +
      (aiResult.scores.feasibility * job.weights.feasibility / 100) +
      (aiResult.scores.impact * job.weights.impact / 100) +
      (aiResult.scores.clarity * job.weights.clarity / 100)
    )
    if (!Number.isFinite(weightedScore) || weightedScore < 0 || weightedScore > 10) {
      throw new Error('Evaluation produced an out-of-range weighted score')
    }

    // Update evaluation with results
    const updateData: any = {
      scores: {
        ...aiResult.scores,
        overall: weightedScore,
      },
      suggestions: aiResult.suggestions,
      status: 'completed',
      updatedAt: new Date(),
    }

    // Add track relevance if available
    if (aiResult.trackRelevance) {
      updateData.trackRelevance = aiResult.trackRelevance
    }

    // Add template validation results if available
    if (templateValidation) {
      updateData.templateValidation = templateValidation
    }

    await Evaluation.findByIdAndUpdate(job.evaluationId, updateData, { runValidators: true })

    logger.info('Hackathon evaluation completed')

    // Update hackathon rankings
    await updateHackathonRankings(job.hackathonId)

  } catch (error) {
    console.error('Hackathon evaluation processing failed:', error)

    // Determine if it's a timeout error
    const isTimeout = error instanceof Error && 
      (error.message.includes('timeout') || Date.now() - startTime > TIMEOUT_MS)

    // Update evaluation with appropriate error status
    await Evaluation.findByIdAndUpdate(job.evaluationId, {
      status: 'failed',
      suggestions: isTimeout 
        ? ['Processing timed out. Please try uploading your file again. Large files may take longer to process.']
        : ['Processing failed. Please try uploading your file again.'],
      updatedAt: new Date(),
    })

    throw error
  }
}

// Update hackathon rankings
async function updateHackathonRankings(hackathonId: string): Promise<void> {
  try {
    // Get all completed evaluations for this hackathon
    const evaluations = await Evaluation.find({
      hackathonId,
      status: 'completed'
    }).sort({ 'scores.overall': -1 })

    // Update rankings
    const updatePromises = evaluations.map((evaluation, index) => {
      return Evaluation.findByIdAndUpdate(evaluation._id, {
        rank: index + 1,
        updatedAt: new Date(),
      })
    })

    await Promise.all(updatePromises)

    // Check if all evaluations are complete and update hackathon status
    const totalEvaluations = await Evaluation.countDocuments({ hackathonId })
    const completedEvaluations = await Evaluation.countDocuments({
      hackathonId,
      status: 'completed'
    })

    if (totalEvaluations === completedEvaluations) {
      await Hackathon.findByIdAndUpdate(hackathonId, {
        status: 'completed',
        updatedAt: new Date(),
      })

      logger.info('Hackathon completed with rankings updated')
    }

  } catch (error) {
    console.error('Failed to update hackathon rankings:', error)
  }
}

// Main processor function
export async function processEvaluationJob(job: EvaluationJob): Promise<void> {
  switch (job.type) {
    case 'personal':
      await processPersonalEvaluation(job)
      break
    case 'hackathon':
      await processHackathonEvaluation(job)
      break
    default:
      throw new Error(`Unknown job type: ${(job as any).type}`)
  }
}
