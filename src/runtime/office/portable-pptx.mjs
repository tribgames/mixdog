import { presentationSlides } from './portable-pptx-package.mjs';
import { handleAddChart, handleSetChartAxis, handleSetChartData, handleSetChartDataLabels, handleSetChartSeries, handleSetChartTrendlineOrSetChartErrorBars } from './portable-pptx-charts.mjs';
import { handleAddCommentOrDeleteComment, handleAddProvenance, handleAddSlide, handleApplyTheme, handleDeleteSlide, handleDuplicateSlide, handleFillTemplate, handleImportSlides, handleKeepSlides, handleMoveSlide, handleReplaceText, handleSetFooterOrSetSlideNumber, handleSetLayout, handleSetNotes, handleSetSlideBackground, handleSetTransition } from './portable-pptx-deck.mjs';
import { handleAddAnimation, handleAddImage, handleAddMedia, handleAddTable, handleAddTextboxOrAddShape, handleAlignShapesOrDistributeShapes, handleCropImage, handleDeleteShape, handleFitText, handleGroupShapesOrUngroupShape, handleSetHyperlink, handleSetShape, handleSetTableDataOrReplaceImage, handleSetText, handleZOrder } from './portable-pptx-shapes.mjs';
export { inspectPptxTextBoxes } from './portable-pptx-core.mjs';

const PPTX_OPERATIONS = Object.freeze({
  add_slide: handleAddSlide,
  delete_slide: handleDeleteSlide,
  move_slide: handleMoveSlide,
  keep_slides: handleKeepSlides,
  add_comment: handleAddCommentOrDeleteComment,
  delete_comment: handleAddCommentOrDeleteComment,
  add_provenance: handleAddProvenance,
  set_hyperlink: handleSetHyperlink,
  duplicate_slide: handleDuplicateSlide,
  z_order: handleZOrder,
  align_shapes: handleAlignShapesOrDistributeShapes,
  distribute_shapes: handleAlignShapesOrDistributeShapes,
  set_notes: handleSetNotes,
  fill_template: handleFillTemplate,
  replace_text: handleReplaceText,
  set_text: handleSetText,
  add_textbox: handleAddTextboxOrAddShape,
  add_shape: handleAddTextboxOrAddShape,
  delete_shape: handleDeleteShape,
  import_slides: handleImportSlides,
  set_slide_background: handleSetSlideBackground,
  add_table: handleAddTable,
  add_image: handleAddImage,
  add_chart: handleAddChart,
  set_chart_data: handleSetChartData,
  set_chart_axis: handleSetChartAxis,
  set_chart_series: handleSetChartSeries,
  set_chart_trendline: handleSetChartTrendlineOrSetChartErrorBars,
  set_chart_error_bars: handleSetChartTrendlineOrSetChartErrorBars,
  set_chart_data_labels: handleSetChartDataLabels,
  fit_text: handleFitText,
  set_table_data: handleSetTableDataOrReplaceImage,
  replace_image: handleSetTableDataOrReplaceImage,
  group_shapes: handleGroupShapesOrUngroupShape,
  ungroup_shape: handleGroupShapesOrUngroupShape,
  set_footer: handleSetFooterOrSetSlideNumber,
  set_slide_number: handleSetFooterOrSetSlideNumber,
  apply_theme: handleApplyTheme,
  add_media: handleAddMedia,
  set_layout: handleSetLayout,
  crop_image: handleCropImage,
  add_animation: handleAddAnimation,
  set_transition: handleSetTransition,
  set_shape: handleSetShape,
});



export async function applyPptx(zip, operations) {
  const context = { zip, slides: await presentationSlides(zip) };
  const results = [];
  for (const op of operations) {
    const handler = PPTX_OPERATIONS[op.op];
    if (!handler) throw new Error(`Portable PPTX backend does not support operation: ${op.op}`);
    const result = await handler(context, op);
    if (result) results.push(result);
  }
  return results;
}
