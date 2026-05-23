import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { useState } from 'react';
import { AuthProvider } from './contexts/AuthContext';
import { HelmetProvider } from 'react-helmet-async';

// Pages
import Landing from './pages/Landing';
import Home from './pages/Home';
import GeneratorContainer from './pages/GeneratorContainer';
import Documents from './pages/Documents';
import Compare from './pages/Compare';
import ImagePromptsContainer from './pages/ImagePromptsContainer';
import ImageGeneratorContainer from './pages/ImageGeneratorContainer';
import TextToSpeechContainer from './pages/TextToSpeechContainer';
import VideoGeneratorContainer from './pages/VideoGeneratorContainer';
import TextToVideoGeneratorContainer from './pages/TextToVideoGeneratorContainer';
import MotionGraphicsGeneratorContainer from './pages/MotionGraphicsGeneratorContainer';
import ImageToVideoGeneratorContainer from './pages/ImageToVideoGeneratorContainer';
import About from './pages/About';
import Pricing from './pages/Pricing';
import Help from './pages/Help';
import Privacy from './pages/Privacy';
import Terms from './pages/Terms';
import Features from './pages/Features';
import SignIn from './pages/SignIn';
import SignUp from './pages/SignUp';
import Subscription from './pages/Subscription';
import AuthCallback from './pages/AuthCallback';
import CombineVideo from './pages/CombineVideo';
import Success from './pages/Success';
import Learn from './pages/Learn';

// Components
import ProtectedRoute from './components/ProtectedRoute';
import PublicLayout from './components/PublicLayout';

function App() {
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  return (
    <AuthProvider>
      <HelmetProvider>
        <Router>
          <Routes>
            {/* Public Routes with Layout */}
            <Route element={<PublicLayout isMenuOpen={isMenuOpen} setIsMenuOpen={setIsMenuOpen} />}>
              <Route index element={<Landing />} />
              <Route path="/:videoId" element={<Navigate to="/help" replace />} />
              <Route path="/about" element={<About />} />
              <Route path="/pricing" element={<Pricing />} />
              <Route path="/help" element={<Help />} />
              <Route path="/help/:videoId" element={<Help />} />
              <Route path="/privacy" element={<Privacy />} />
              <Route path="/terms" element={<Terms />} />
              <Route path="/features" element={<Features />} />
            </Route>

            {/* Auth Routes - No Layout */}
            <Route path="/signin" element={<SignIn />} />
            <Route path="/signup" element={<SignUp />} />
            <Route path="/auth/callback" element={<AuthCallback />} />
            <Route path="/success" element={<Success />} />

            {/* Protected Routes */}
            <Route path="/home" element={
              <ProtectedRoute>
                <Home />
              </ProtectedRoute>
            } />
            <Route path="/generator" element={
              <ProtectedRoute>
                <GeneratorContainer />
              </ProtectedRoute>
            } />
            <Route path="/documents" element={
              <ProtectedRoute>
                <Documents />
              </ProtectedRoute>
            } />
            <Route path="/compare" element={
              <ProtectedRoute>
                <Compare />
              </ProtectedRoute>
            } />
            <Route path="/image-prompts" element={
              <ProtectedRoute>
                <ImagePromptsContainer />
              </ProtectedRoute>
            } />
            <Route path="/image-generator" element={
              <ProtectedRoute>
                <ImageGeneratorContainer />
              </ProtectedRoute>
            } />
            <Route path="/text-to-speech" element={
              <ProtectedRoute>
                <TextToSpeechContainer />
              </ProtectedRoute>
            } />
            <Route path="/combine-video" element={
              <ProtectedRoute>
                <CombineVideo />
              </ProtectedRoute>
            } />
            <Route path="/video-generator" element={
              <ProtectedRoute>
                <VideoGeneratorContainer />
              </ProtectedRoute>
            } />
            <Route path="/text-to-video-generator" element={
              <ProtectedRoute>
                <TextToVideoGeneratorContainer />
              </ProtectedRoute>
            } />
            <Route path="/motion-graphics-generator" element={
              <ProtectedRoute>
                <MotionGraphicsGeneratorContainer />
              </ProtectedRoute>
            } />
            <Route path="/image-to-video" element={
              <ProtectedRoute>
                <ImageToVideoGeneratorContainer />
              </ProtectedRoute>
            } />
            <Route path="/learn" element={
              <ProtectedRoute>
                <Learn />
              </ProtectedRoute>
            } />
            <Route path="/subscription" element={
              <ProtectedRoute>
                <Subscription />
              </ProtectedRoute>
            } />

            {/* Catch all - redirect to landing page */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Router>
      </HelmetProvider>
    </AuthProvider>
  );
}

export default App;



